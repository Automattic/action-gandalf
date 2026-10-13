import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import yauzl from 'yauzl';
import { buildBundle, ensureBase } from '../src/bundle';
import { type GithubScanContext, parseGithubChangeManifest } from '../src/github-scan-contract';
import { submitScan } from '../src/submit';

const fixture: { manifest: unknown; files: Record<string, string> } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/github-changes.json'), 'utf8'),
);
const parsed = parseGithubChangeManifest(fixture.manifest);
if (!parsed.ok) throw new Error(parsed.message);
const golden = parsed.value;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gandalf-action-test-'));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}
async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
function commit(root: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}
async function repo(): Promise<{ root: string; context: GithubScanContext }> {
  const root = await scratch();
  git(root, 'init', '-q');
  for (const [path, content] of Object.entries(fixture.files))
    if (path.startsWith('before/')) await put(root, path.slice(7), content);
  await put(root, 'plugin/unchanged.php', '<?php unchanged();');
  await put(root, 'unrelated/ignored.php', '<?php before();');
  const base_sha = commit(root);
  for (const path of Object.keys(fixture.files))
    if (path.startsWith('before/')) await rm(join(root, path.slice(7)));
  for (const [path, content] of Object.entries(fixture.files))
    if (path.startsWith('after/')) await put(root, path.slice(6), content);
  await chmod(join(root, 'plugin/mode.php'), 0o755);
  await symlink('/etc/passwd', join(root, 'plugin/link.php'));
  await put(root, 'unrelated/ignored.php', '<?php after();');
  const checkout_sha = commit(root);
  return { root, context: { ...golden.context, base_sha, checkout_sha } };
}
async function entries(path: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, decodeStrings: false }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const result = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zip.openReadStream(entry, (error, value) => (error ? rej(error) : res(value))),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          assert(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
        result.set(entry.fileNameRaw.toString('utf8'), Buffer.concat(chunks));
        zip.readEntry();
      })().catch(reject);
    });
    zip.readEntry();
  });
  return result;
}

test('bundles exact committed changes including deletions, renames, modes and unusual filenames', async () => {
  const { root, context } = await repo();
  await put(root, 'plugin/edit.php', 'dirty worktree must never enter the source bundle');
  const bundle = await buildBundle(root, await scratch(), context);
  assert(bundle.kind === 'changed');
  const actual = await entries(bundle.path);
  assert.equal(bundle.manifest.changes.length, 6);
  assert.deepEqual(
    [...actual.keys()].sort(),
    [
      'changes/manifest.json',
      ...Object.keys(fixture.files).map((path) => `changes/${path}`),
    ].sort(),
  );
  for (const [path, content] of Object.entries(fixture.files))
    assert.equal(actual.get(`changes/${path}`)?.toString(), content);
  assert(
    bundle.manifest.changes.some(
      (change) => change.status === 'R' && change.before.path === 'plugin/rename.php',
    ),
  );
  assert(
    bundle.manifest.changes.some(
      (change) => change.status === 'M' && change.after.mode === '100755',
    ),
  );
  assert(
    bundle.manifest.changes.some(
      (change) => change.status === 'A' && change.after.mode === '120000',
    ),
  );
  const manifest = parseGithubChangeManifest(
    JSON.parse(actual.get('changes/manifest.json')?.toString() ?? 'null'),
  );
  assert(manifest.ok);
  assert.deepEqual(manifest.value, bundle.manifest);
  for (const change of bundle.manifest.changes)
    for (const side of ['before', 'after'] as const) {
      const file =
        side === 'before'
          ? 'before' in change
            ? change.before
            : undefined
          : 'after' in change
            ? change.after
            : undefined;
      if (file === undefined || !('sha256' in file)) continue;
      const bytes = actual.get(`changes/${side}/${file.path}`);
      assert(bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      assert.equal(
        createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
        file.oid,
      );
    }
});
test('supports a theme and explicitly scoped shared source, and skips an unchanged comparison', async () => {
  const { root, context } = await repo();
  const bundle = await buildBundle(root, await scratch(), {
    ...context,
    type: 'theme',
    additional_source_paths: ['unrelated'],
  });
  assert(bundle.kind === 'changed');
  assert.equal(bundle.manifest.context.type, 'theme');
  assert.equal(bundle.manifest.changes.length, 7);
  assert.deepEqual(
    await buildBundle(root, await scratch(), { ...context, base_sha: context.checkout_sha }),
    { kind: 'unchanged' },
  );
  await ensureBase(root, context.base_sha);
});
test('fetches an absent base from the checkout origin', async () => {
  const { root, context } = await repo();
  const checkout = await scratch();
  git(checkout, 'clone', '--quiet', '--no-local', '--depth=1', root, '.');
  const missing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${context.base_sha}^{commit}`], { cwd: checkout });
  assert.equal(missing.status, 1);
  await ensureBase(checkout, context.base_sha);
  assert.equal(git(checkout, 'rev-parse', '--verify', context.base_sha), context.base_sha);
});

test('does not fetch when the checkout itself is invalid', async () => {
  await assert.rejects(ensureBase(await scratch(), golden.context.base_sha), (error) => {
    assert(error instanceof Error && 'cmd' in error);
    assert.doesNotMatch(String(error.cmd), /fetch/);
    return true;
  });
});

test('represents a deletion-only comparison without inventing a checkout file', async () => {
  const root = await scratch();
  git(root, 'init', '-q');
  await put(root, 'plugin/only.php', '<?php deleted();');
  const base_sha = commit(root);
  await rm(join(root, 'plugin/only.php'));
  const checkout_sha = commit(root);
  const bundle = await buildBundle(root, await scratch(), {
    ...golden.context,
    base_sha,
    checkout_sha,
  });
  assert(bundle.kind === 'changed');
  assert.deepEqual([...(await entries(bundle.path)).keys()].sort(), [
    'changes/before/plugin/only.php',
    'changes/manifest.json',
  ]);
});
test('fails explicitly when changed source exceeds 20 MiB compressed', async () => {
  const root = await scratch();
  git(root, 'init', '-q');
  await put(root, 'plugin/keep.php', '<?php keep();');
  const base_sha = commit(root);
  await put(root, 'plugin/large.dat', randomBytes(21 * 1024 * 1024));
  const checkout_sha = commit(root);
  await assert.rejects(
    buildBundle(root, await scratch(), { ...golden.context, base_sha, checkout_sha }),
    /exceeds 20 MiB/,
  );
});
test('retries the same invocation and bytes after a lost response and server failure', async () => {
  const root = await scratch();
  const changes = join(root, 'changes.zip');
  const runtimeZip = join(root, 'runtime.zip');
  await writeFile(changes, 'source zip fixture');
  await writeFile(runtimeZip, 'runtime zip fixture');
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const bodies: string[][] = [];
  let attempts = 0;
  const receipt = await submitScan(
    { token: 'fixture-secret', invocationId, context: golden.context, changes, runtimeZip },
    {
      sleep: async () => {},
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get('Idempotency-Key'), invocationId);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-secret');
        assert.equal(init?.redirect, 'error');
        assert(init?.body instanceof FormData);
        const source = init.body.get('changes');
        const runtime = init.body.get('runtime_zip');
        assert(source instanceof Blob);
        assert(runtime instanceof Blob);
        bodies.push([await source.text(), await runtime.text(), String(init.body.get('metadata'))]);
        attempts++;
        if (attempts === 1) throw new Error('lost response');
        if (attempts === 2) return new Response('', { status: 503 });
        return Response.json({ scan_id: invocationId, accepted_at: 42 }, { status: 202 });
      },
    },
  );
  assert.equal(receipt.accepted_at, 42);
  assert.equal(attempts, 3);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
});
test('does not retry authentication rejection or expose response text', async () => {
  const changes = join(await scratch(), 'changes.zip');
  await writeFile(changes, 'zip');
  let attempts = 0;
  await assert.rejects(
    submitScan(
      { token: 'fixture-secret', invocationId: 'fixture-id', context: golden.context, changes },
      {
        fetch: async () => {
          attempts++;
          return new Response('fixture-secret', { status: 401 });
        },
      },
    ),
    (error) =>
      error instanceof Error &&
      /HTTP 401/.test(error.message) &&
      !error.message.includes('fixture-secret'),
  );
  assert.equal(attempts, 1);
});

test('distributed entrypoint runs without node_modules and submits the actual checkout SHA', async () => {
  const { root, context } = await repo();
  const isolated = await scratch();
  await copyFile(join(__dirname, '../dist/index.js'), join(isolated, 'index.cjs'));
  const eventPath = join(isolated, 'event.json');
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 42,
        base: { sha: context.base_sha },
        head: { sha: 'c'.repeat(40), repo: { full_name: context.repository } },
      },
    }),
  );
  const output = join(isolated, 'output');
  await writeFile(output, '');
  const capture = join(isolated, 'capture.json');
  const preload = join(isolated, 'mock-http.cjs');
  await writeFile(
    preload,
    `const fs = require('node:fs');
global.fetch = async (url, init) => {
  const metadata = JSON.parse(init.body.get('metadata'));
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({url, metadata, sourceBytes: init.body.get('changes').size}));
  return Response.json({scan_id: new Headers(init.headers).get('Idempotency-Key'), accepted_at: 42}, {status:202});
};`,
  );
  const runnerEnv = {
      ...process.env,
      INPUT_TOKEN: 'fixture-secret',
      INPUT_TYPE: 'plugin',
      'INPUT_PRODUCT-PATH': 'plugin',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_WORKSPACE: root,
      GITHUB_REPOSITORY: context.repository,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SERVER_URL: context.server_url,
      GITHUB_REPOSITORY_ID: context.repository_id,
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: isolated,
  };
  const command = ['--require', preload, join(isolated, 'index.cjs')];
  execFileSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: runnerEnv });
  const submitted = JSON.parse(await readFile(capture, 'utf8')) as {
    url: string;
    metadata: Record<string, unknown>;
    sourceBytes: number;
  };
  assert.equal(submitted.url, 'https://gandalf.wordpress.org/scan?scan_type=github');
  assert.equal(submitted.metadata['checkout_sha'], context.checkout_sha);
  assert.equal(submitted.metadata['pr_head_sha'], 'c'.repeat(40));
  assert.equal(submitted.metadata['pull_request'], 42);
  assert(submitted.sourceBytes > 0);
  assert.match(await readFile(output, 'utf8'), /accepted/);
  // A push has no PR identity: the workflow explicitly supplies its before SHA.
  await writeFile(eventPath, JSON.stringify({ before: context.base_sha, after: context.checkout_sha }));
  const pushEnv = { ...runnerEnv, GITHUB_EVENT_NAME: 'push', 'INPUT_BASE-SHA': context.base_sha };
  execFileSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: pushEnv });
  const pushed = JSON.parse(await readFile(capture, 'utf8')) as { metadata: Record<string, unknown> };
  assert.equal(pushed.metadata['base_sha'], context.base_sha);
  assert.equal(pushed.metadata['checkout_sha'], context.checkout_sha);
  assert.equal('pull_request' in pushed.metadata, false);
  assert.equal('pr_head_sha' in pushed.metadata, false);
  for (const [name, message] of [
    ['INPUT_PRODUCT-PATH', 'Input required and not supplied: product-path'],
    ['RUNNER_TEMP', 'Missing RUNNER_TEMP'],
  ] as const) {
    await rm(capture, { force: true });
    const invalid = spawnSync(process.execPath, command, {
      cwd: root, encoding: 'utf8', env: { ...pushEnv, [name]: '' },
    });
    assert.equal(invalid.status, 1);
    assert((invalid.stdout + invalid.stderr).includes(message));
    await assert.rejects(readFile(capture), { code: 'ENOENT' });
  }
});


test('manifest rejects coercive file modes and change statuses', () => {
  for (const mode of [100644, ['100644'], 120000, ['160000']]) {
    assert.deepEqual(parseGithubChangeManifest({
      ...golden,
      changes: [{ status: 'A', after: { path: 'plugin/example.php', oid: 'a'.repeat(40), mode } }],
    }), { ok: false, message: 'invalid Git file mode' });
  }
  assert.deepEqual(parseGithubChangeManifest({
    ...golden,
    changes: [{ status: ['M'], before: { path: 'plugin/a.php', oid: 'a'.repeat(40), mode: '120000' },
      after: { path: 'plugin/b.php', oid: 'b'.repeat(40), mode: '120000' } }],
  }), { ok: false, message: 'unsupported Git change status' });
});
