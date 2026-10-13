import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { GITHUB_REQUEST_MAX_BYTES, type GithubScanContext } from './github-scan-contract';

export const GANDALF_ENDPOINT = 'https://gandalf.wordpress.org/scan?scan_type=github';
export interface Acceptance {
  readonly scan_id: string;
  readonly accepted_at: number;
}

export async function submitScan(
  input: {
    readonly token: string;
    readonly invocationId: string;
    readonly context: GithubScanContext;
    readonly changes: string;
    readonly runtimeZip?: string;
  },
  deps: {
    readonly endpoint?: string;
    readonly fetch?: typeof fetch;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Acceptance> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const metadata = JSON.stringify(input.context);
  const sourceBytes = (await stat(input.changes)).size;
  const runtimeBytes = input.runtimeZip === undefined ? 0 : (await stat(input.runtimeZip)).size;
  if (sourceBytes + runtimeBytes + Buffer.byteLength(metadata) + 2048 > GITHUB_REQUEST_MAX_BYTES)
    throw new Error('Source and runtime package exceed the 512 MiB request limit');
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = new FormData();
    body.set('metadata', metadata);
    body.set(
      'changes',
      await openAsBlob(input.changes, { type: 'application/zip' }),
      'changes.zip',
    );
    if (input.runtimeZip !== undefined)
      body.set(
        'runtime_zip',
        await openAsBlob(input.runtimeZip, { type: 'application/zip' }),
        'runtime.zip',
      );
    let response: Response;
    try {
      response = await fetchImpl(deps.endpoint ?? GANDALF_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.token}`, 'Idempotency-Key': input.invocationId },
        redirect: 'error',
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      if (attempt === 2)
        throw new Error(
          `Gandalf submission could not be confirmed; invocation ${input.invocationId}`,
        );
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status === 202) {
      const value: unknown = await response.json();
      if (
        value === null ||
        typeof value !== 'object' ||
        !('scan_id' in value) ||
        value.scan_id !== input.invocationId ||
        !('accepted_at' in value) ||
        typeof value.accepted_at !== 'number' ||
        !Number.isSafeInteger(value.accepted_at) ||
        value.accepted_at < 0
      )
        throw new Error('Gandalf returned an invalid acceptance receipt');
      return { scan_id: value.scan_id, accepted_at: value.accepted_at };
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      const retryAfter = response.headers.get('retry-after');
      const seconds =
        retryAfter !== null && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : 2 ** attempt;
      await sleep(Math.min(seconds * 1000, 30_000));
      continue;
    }
    await response.body?.cancel();
    throw new Error(
      `Gandalf rejected submission (HTTP ${response.status}); invocation ${input.invocationId}`,
    );
  }
  throw new Error('Submission retry loop ended without an outcome');
}
