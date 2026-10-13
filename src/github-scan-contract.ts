/** Public action -> server -> CLI contract. No GitHub credentials travel with it. */
export const GITHUB_CHANGES_VERSION = 'gandalf-github-changes-v1' as const;
export const GITHUB_CALLBACK_VERSION = 'gandalf-github-completion-v1' as const;
export const GITHUB_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const GITHUB_REQUEST_MAX_BYTES = 512 * 1024 * 1024;
export const GITHUB_EXPANDED_MAX_BYTES = 1024 * 1024 * 1024;
export const GITHUB_ARCHIVE_MAX_ENTRIES = 100_000;
export const GITHUB_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const GITHUB_METADATA_MAX_BYTES = 64 * 1024;
export const GITHUB_RULESET = 'github-security' as const;

export interface GithubScanContext {
  readonly server_url: 'https://github.com' | 'https://github.a8c.com';
  readonly repository: string;
  readonly repository_id: string;
  readonly product_path: string;
  readonly additional_source_paths: readonly string[];
  readonly type: 'plugin' | 'theme';
  readonly base_sha: string;
  readonly checkout_sha: string;
  readonly pr_head_sha?: string;
  readonly pull_request?: number;
  readonly run_id: string;
  readonly run_attempt: number;
}

export type GithubFile = {
  readonly path: string;
  readonly oid: string;
} & (
  | { readonly mode: '100644' | '100755'; readonly sha256: string; readonly bytes: number }
  | { readonly mode: '120000' | '160000' }
);

export type GithubChange =
  | { readonly status: 'A'; readonly after: GithubFile }
  | { readonly status: 'D'; readonly before: GithubFile }
  | { readonly status: 'M' | 'R' | 'T'; readonly before: GithubFile; readonly after: GithubFile };

export interface GithubChangeManifest {
  readonly schema_version: typeof GITHUB_CHANGES_VERSION;
  readonly context: GithubScanContext;
  readonly changes: readonly GithubChange[];
}

export type GithubParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function isRegularGithubFile(file: GithubFile): file is GithubFile & {
  readonly mode: '100644' | '100755';
  readonly sha256: string;
  readonly bytes: number;
} {
  return file.mode === '100644' || file.mode === '100755';
}

/** Git paths are literal POSIX paths, never globs, URLs or OS file paths. */
export function isGithubSourcePath(value: unknown, allowRoot = false): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    ((allowRoot && value === '.') ||
      (!value.includes('\\') &&
        !value.includes('\0') &&
        !/^[A-Za-z]:/u.test(value) &&
        value
          .split('/')
          .every(
            (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
          )))
  );
}

export function isGithubPathInScope(path: string, context: GithubScanContext): boolean {
  return [context.product_path, ...context.additional_source_paths].some(
    (root) => root === '.' || path === root || path.startsWith(`${root}/`),
  );
}

export function parseGithubScanContext(value: unknown): GithubParseResult<GithubScanContext> {
  try {
    validateContext(value);
    return { ok: true, value: value as GithubScanContext };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function parseGithubChangeManifest(value: unknown): GithubParseResult<GithubChangeManifest> {
  try {
    const root = record(value, ['schema_version', 'context', 'changes']);
    requireValue(
      root['schema_version'] === GITHUB_CHANGES_VERSION,
      'unsupported change bundle version',
    );
    validateContext(root['context']);
    const context = root['context'] as GithubScanContext;
    const changes = root['changes'];
    requireValue(
      Array.isArray(changes) && changes.length > 0 && changes.length <= 49_999,
      'changes must contain between 1 and 49,999 entries',
    );
    const beforePaths = new Set<string>();
    const afterPaths = new Set<string>();
    let expanded = 0;
    for (const raw of changes) {
      const change = record(raw, ['status', 'before', 'after']);
      const status = change['status'];
      requireValue(
        typeof status === 'string' && ['A', 'D', 'M', 'R', 'T'].includes(status),
        'unsupported Git change status',
      );
      requireValue((status !== 'A') === 'before' in change, 'invalid before side');
      requireValue((status !== 'D') === 'after' in change, 'invalid after side');
      for (const side of ['before', 'after'] as const) {
        if (!(side in change)) continue;
        validateFile(change[side]);
        const file = change[side] as GithubFile;
        requireValue(
          isGithubPathInScope(file.path, context),
          'file lies outside configured source paths',
        );
        const paths = side === 'before' ? beforePaths : afterPaths;
        requireValue(!paths.has(file.path), 'duplicate source path');
        paths.add(file.path);
        if (isRegularGithubFile(file)) expanded += file.bytes;
      }
      if (status === 'M' || status === 'T' || status === 'R') {
        const before = change['before'] as GithubFile;
        const after = change['after'] as GithubFile;
        requireValue(
          status === 'R' ? before.path !== after.path : before.path === after.path,
          'change paths do not match status',
        );
        requireValue(
          before.oid !== after.oid || before.mode !== after.mode || status === 'R',
          'unchanged file in change bundle',
        );
      }
    }
    requireValue(expanded <= GITHUB_EXPANDED_MAX_BYTES, 'expanded source limit exceeded');
    return { ok: true, value: value as GithubChangeManifest };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Stable identity across JSON object key order; array order remains significant. */
export function serializeGithubChangeManifest(manifest: GithubChangeManifest): string {
  return JSON.stringify(manifest, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return value;
  });
}

function validateContext(value: unknown): void {
  const c = record(value, [
    'server_url',
    'repository',
    'repository_id',
    'product_path',
    'additional_source_paths',
    'type',
    'base_sha',
    'checkout_sha',
    'pr_head_sha',
    'pull_request',
    'run_id',
    'run_attempt',
  ]);
  requireValue(
    c['server_url'] === 'https://github.com' || c['server_url'] === 'https://github.a8c.com',
    'unsupported GitHub host',
  );
  requireValue(
    typeof c['repository'] === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(c['repository']),
    'invalid repository',
  );
  const owner = c['repository'].split('/')[0]?.toLowerCase();
  requireValue(
    owner === 'automattic' || (c['server_url'] === 'https://github.com' && owner === 'woocommerce'),
    'unsupported repository organization',
  );
  requireValue(
    typeof c['repository_id'] === 'string' && /^[1-9][0-9]*$/u.test(c['repository_id']),
    'invalid repository ID',
  );
  requireValue(isGithubSourcePath(c['product_path'], true), 'invalid product path');
  const additional = c['additional_source_paths'];
  requireValue(
    Array.isArray(additional) &&
      additional.length <= 100 &&
      additional.every((path) => isGithubSourcePath(path, true)),
    'invalid additional source paths',
  );
  requireValue(new Set(additional).size === additional.length, 'duplicate additional source path');
  requireValue(
    c['type'] === 'plugin' || c['type'] === 'theme',
    'only WordPress plugins and themes are supported',
  );
  oid(c['base_sha']);
  oid(c['checkout_sha']);
  if ('pr_head_sha' in c) oid(c['pr_head_sha']);
  requireValue('pr_head_sha' in c === 'pull_request' in c, 'incomplete pull request identity');
  if ('pull_request' in c) positiveInteger(c['pull_request']);
  requireValue(
    typeof c['run_id'] === 'string' && /^[1-9][0-9]*$/u.test(c['run_id']),
    'invalid run ID',
  );
  positiveInteger(c['run_attempt']);
}

function validateFile(value: unknown): void {
  const f = record(value, ['path', 'oid', 'mode', 'sha256', 'bytes']);
  requireValue(isGithubSourcePath(f['path']), 'invalid source path');
  oid(f['oid']);
  requireValue(
    typeof f['mode'] === 'string' && ['100644', '100755', '120000', '160000'].includes(f['mode']),
    'invalid Git file mode',
  );
  if (f['mode'] === '100644' || f['mode'] === '100755') {
    requireValue(
      typeof f['sha256'] === 'string' && /^[0-9a-f]{64}$/u.test(f['sha256']),
      'invalid content digest',
    );
    requireValue(
      typeof f['bytes'] === 'number' && Number.isSafeInteger(f['bytes']) && f['bytes'] >= 0,
      'invalid file size',
    );
  } else
    requireValue(!('sha256' in f) && !('bytes' in f), 'links and submodules must be metadata only');
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected object',
  );
  requireValue(
    Object.keys(value).every((key) => keys.includes(key)),
    'unexpected field',
  );
  return value as Record<string, unknown>;
}
function oid(value: unknown): void {
  requireValue(
    typeof value === 'string' &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) &&
      !/^0+$/u.test(value),
    'invalid Git object ID',
  );
}
function positiveInteger(value: unknown): void {
  requireValue(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'expected positive integer',
  );
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
