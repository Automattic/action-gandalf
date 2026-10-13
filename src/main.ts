import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as core from '@actions/core';
import { buildBundle, ensureBase, gitText } from './bundle';
import { parseGithubScanContext } from './github-scan-contract';
import { submitScan } from './submit';

async function main(): Promise<void> {
  const token = core.getInput('token', { required: true });
  core.setSecret(token);
  if (requiredEnv('GITHUB_EVENT_NAME') === 'pull_request_target')
    throw new Error(
      'pull_request_target is not supported; use a trusted workflow with a checked-out reviewed commit',
    );
  const workspace = requiredEnv('GITHUB_WORKSPACE');
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const event = record(JSON.parse(await readFile(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')));
  const pr = event['pull_request'] === undefined ? undefined : record(event['pull_request']);
  const base = pr === undefined ? undefined : record(pr['base']);
  const head = pr === undefined ? undefined : record(pr['head']);
  if (head !== undefined && record(head['repo'])['full_name'] !== repository)
    throw new Error('Fork pull requests are not supported in v1');
  const baseSha = core.getInput('base-sha') || (base === undefined ? '' : text(base['sha']));
  if (baseSha === '') throw new Error('base-sha is required outside a pull request');
  await ensureBase(workspace, baseSha);
  const checkoutSha = await gitText(workspace, ['rev-parse', 'HEAD']);
  const context = parseGithubScanContext({
    server_url: requiredEnv('GITHUB_SERVER_URL'),
    repository,
    repository_id: requiredEnv('GITHUB_REPOSITORY_ID'),
    product_path: core.getInput('product-path') || '.',
    additional_source_paths: core.getMultilineInput('additional-source-paths'),
    type: core.getInput('type', { required: true }),
    base_sha: baseSha,
    checkout_sha: checkoutSha,
    ...(pr === undefined || head === undefined
      ? {}
      : { pull_request: pr['number'], pr_head_sha: text(head['sha']) }),
    run_id: requiredEnv('GITHUB_RUN_ID'),
    run_attempt: Number(requiredEnv('GITHUB_RUN_ATTEMPT')),
  });
  if (!context.ok) throw new Error(context.message);
  const scratch = await mkdtemp(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'gandalf-action-'));
  try {
    const bundle = await buildBundle(workspace, scratch, context.value);
    if (bundle === null) {
      core.setOutput('status', 'skipped');
      core.setOutput('scan-id', '');
      core.setOutput('accepted-at', '');
      core.info('No scoped source changes; scan skipped.');
      return;
    }
    core.info(
      `Submitting ${bundle.manifest.changes.length} changes (${bundle.bytes} compressed bytes) for ${checkoutSha}.`,
    );
    const runtime = core.getInput('runtime-zip');
    const accepted = await submitScan({
      token,
      invocationId: randomUUID(),
      context: context.value,
      changes: bundle.path,
      ...(runtime === '' ? {} : { runtimeZip: resolve(workspace, runtime) }),
    });
    core.setOutput('status', 'accepted');
    core.setOutput('scan-id', accepted.scan_id);
    core.setOutput('accepted-at', accepted.accepted_at);
    core.info(
      `Gandalf accepted scan ${accepted.scan_id}. Mission Control will receive the asynchronous results.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing ${name}`);
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid GitHub event payload');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid GitHub event revision');
  return value;
}

void main().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
