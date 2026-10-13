import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { ZipFile } from 'yazl';
import {
  GITHUB_CHANGES_VERSION,
  GITHUB_EXPANDED_MAX_BYTES,
  GITHUB_MANIFEST_MAX_BYTES,
  GITHUB_SOURCE_MAX_BYTES,
  type GithubChange,
  type GithubChangeManifest,
  type GithubFile,
  type GithubScanContext,
  isGithubSourcePath,
  parseGithubChangeManifest,
} from './github-scan-contract';

const exec = promisify(execFile);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export async function gitText(workspace: string, args: readonly string[]): Promise<string> {
  const result = await exec('git', ['--literal-pathspecs', ...args], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function ensureBase(workspace: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error('base-sha must be a full commit SHA');
  try {
    await gitText(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    await gitText(workspace, ['fetch', '--no-tags', '--depth=1', 'origin', sha]);
  }
  await gitText(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
}

export async function buildBundle(
  workspace: string,
  scratch: string,
  context: GithubScanContext,
): Promise<{
  readonly path: string;
  readonly bytes: number;
  readonly manifest: GithubChangeManifest;
} | null> {
  const scopes = [context.product_path, ...context.additional_source_paths];
  if (scopes.some((path) => !isGithubSourcePath(path, true)))
    throw new Error('Source paths must be literal repository-relative paths');
  const raw = await exec(
    'git',
    [
      '--literal-pathspecs',
      'diff',
      '--raw',
      '--no-abbrev',
      '-z',
      '--find-renames=50%',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=none',
      context.base_sha,
      context.checkout_sha,
      '--',
      ...scopes,
    ],
    { cwd: workspace, encoding: 'buffer', maxBuffer: GITHUB_MANIFEST_MAX_BYTES },
  );
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw.stdout);
  if (decoded === '') return null;
  if (!decoded.endsWith('\0')) throw new Error('Truncated Git change output');
  const fields = decoded.slice(0, -1).split('\0');
  const changes: GithubChange[] = [];
  const blobs = new Map<string, { path: string; sha256: string; bytes: number }>();
  let expanded = 0;
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++];
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMRT])\d*$/u.exec(header ?? '');
    if (match === null) throw new Error('Unsupported Git change record');
    const [, oldMode, newMode, oldOid, newOid, status] = match;
    const oldPath = fields[index++];
    const newPath = status === 'R' ? fields[index++] : oldPath;
    if (
      oldPath === undefined ||
      newPath === undefined ||
      oldMode === undefined ||
      newMode === undefined ||
      oldOid === undefined ||
      newOid === undefined
    )
      throw new Error('Incomplete Git change record');
    const before = oldMode === '000000' ? undefined : await file(oldPath, oldMode, oldOid);
    const after = newMode === '000000' ? undefined : await file(newPath, newMode, newOid);
    if (status === 'A' && after !== undefined && before === undefined)
      changes.push({ status, after });
    else if (status === 'D' && before !== undefined && after === undefined)
      changes.push({ status, before });
    else if (
      (status === 'M' || status === 'R' || status === 'T') &&
      before !== undefined &&
      after !== undefined
    )
      changes.push({ status, before, after });
    else throw new Error('Git change sides do not match status');
    if (changes.length > 49_999) throw new Error('Too many changed files');
  }
  const manifest: GithubChangeManifest = {
    schema_version: GITHUB_CHANGES_VERSION,
    context,
    changes,
  };
  const parsed = parseGithubChangeManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.message);
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (
    encoded.length > GITHUB_MANIFEST_MAX_BYTES ||
    expanded + encoded.length > GITHUB_EXPANDED_MAX_BYTES
  )
    throw new Error('Expanded source/manifest limit exceeded');
  const path = join(scratch, 'changes.zip');
  const zip = new ZipFile();
  zip.on('error', (error: Error) => zip.outputStream.emit('error', error));
  let compressed = 0;
  const writing = pipeline(
    zip.outputStream,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        compressed += chunk.length;
        callback(
          compressed > GITHUB_SOURCE_MAX_BYTES
            ? new Error('Changed-file source bundle exceeds 20 MiB; no files were discarded')
            : null,
          chunk,
        );
      },
    }),
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  // Attach a rejection handler immediately while ZIP streams are being added.
  const result = writing.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const options = { mtime: new Date('1980-01-01T00:00:00Z'), mode: 0o100644 };
  zip.addBuffer(encoded, 'changes/manifest.json', options);
  for (const change of changes)
    for (const side of ['before', 'after'] as const) {
      const source =
        side === 'before'
          ? 'before' in change
            ? change.before
            : undefined
          : 'after' in change
            ? change.after
            : undefined;
      if (source === undefined || source.mode === '120000' || source.mode === '160000') continue;
      const blob = blobs.get(source.oid);
      if (blob === undefined) throw new Error('Missing captured Git blob');
      zip.addFile(blob.path, `changes/${side}/${source.path}`, options);
    }
  zip.end();
  const failure = await result;
  if (failure !== null) throw failure;
  return { path, bytes: (await stat(path)).size, manifest };

  async function file(path: string, mode: string, oid: string): Promise<GithubFile> {
    if (!isGithubSourcePath(path) || !SHA.test(oid))
      throw new Error('Unsupported Git source path or object ID');
    if (mode === '120000' || mode === '160000') return { path, mode, oid };
    if (mode !== '100644' && mode !== '100755') throw new Error('Unsupported Git file mode');
    let blob = blobs.get(oid);
    if (blob === undefined) {
      const blobPath = join(scratch, `blob-${oid}`);
      blob = { path: blobPath, ...(await captureBlob(workspace, oid, blobPath)) };
      blobs.set(oid, blob);
    }
    expanded += blob.bytes;
    if (expanded > GITHUB_EXPANDED_MAX_BYTES) throw new Error('Expanded source limit exceeded');
    return { path, mode, oid, sha256: blob.sha256, bytes: blob.bytes };
  }
}

async function captureBlob(
  workspace: string,
  oid: string,
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const child = spawn('git', ['cat-file', 'blob', oid], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Git blob read failed')),
    );
  });
  const hash = createHash('sha256');
  let bytes = 0;
  const copy = pipeline(
    child.stdout,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(
          bytes > GITHUB_EXPANDED_MAX_BYTES
            ? new Error('Changed file exceeds expanded source limit')
            : null,
          chunk,
        );
      },
    }),
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  try {
    await Promise.all([copy, exit]);
  } catch (error) {
    child.kill();
    await Promise.allSettled([copy, exit]);
    throw error;
  }
  return { sha256: hash.digest('hex'), bytes };
}
