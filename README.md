# Gandalf action

Review changes to a WordPress plugin or theme with Gandalf. The action packages
changed source files, submits them and finishes. Gandalf performs the scan and any
runtime investigation, then sends results to Mission Control for presentation and
notifications.

The examples use `Automattic/action-gandalf@trunk` to pick up updates as they land.
Use a reviewed commit SHA when you need a fixed action version.

## Recommended: scan changes merged into trunk

Run after changes land on `trunk` to avoid scanning every PR update. Each push is
reviewed from the previous trunk SHA (`before`) to the new SHA (`after`). This
includes squash merges and pushes containing several commits. It reports changes
after they land; it does not block the merge.

### Single plugin or theme

For a plugin at the repository root, add this workflow to
`.github/workflows/gandalf.yml`. Replace `trunk` if your default branch has another
name, or use `type: theme` for a theme.

```yaml
name: Gandalf
on:
  push:
    branches: [trunk]

permissions:
  contents: read

jobs:
  scan:
    if: github.event.created == false && github.event.deleted == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.after }}
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@trunk
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
          base-sha: ${{ github.event.before }}
```

The checkout is pinned to that push's exact commit, even if another merge happens
before the job starts. The job condition skips branch creation and deletion, which
do not have two existing branch revisions to compare.

### A product in a monorepo

Set `product-path` to the plugin or theme directory. Optionally include shared
source that the product depends on:

```yaml
name: Gandalf
on:
  push:
    branches: [trunk]

permissions:
  contents: read

jobs:
  scan:
    if: github.event.created == false && github.event.deleted == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.after }}
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@trunk
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
          base-sha: ${{ github.event.before }}
          product-path: plugins/my-plugin
          additional-source-paths: |
            packages/shared
```

Paths are literal repository-relative paths, not globs. Omit
`additional-source-paths` when it is not needed. Invoke once per product; use a job
matrix if you want to scan several products. Products with no changes in their
configured paths are skipped.

## Alternative: scan every PR update

Choose PR scans when you want feedback before merging, accepting the additional
runs as the PR changes. The action compares the checkout with the PR base. The
standard `pull_request` trigger runs when a PR opens, reopens or receives new commits.
These examples skip fork PRs, which the action does not support.

### Single plugin or theme

```yaml
name: Gandalf
on: [pull_request]

permissions:
  contents: read

jobs:
  scan:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@trunk
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
```

### A product in a monorepo

```yaml
name: Gandalf
on: [pull_request]

permissions:
  contents: read

jobs:
  scan:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@trunk
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
          product-path: plugins/my-plugin
          additional-source-paths: |
            packages/shared
```

## Optional runtime investigation

If your workflow already builds an installable plugin or theme ZIP, pass its path
with `runtime-zip`. Build it from the same checkout being reviewed:

```yaml
- uses: Automattic/action-gandalf@trunk
  with:
    token: ${{ secrets.GANDALF_API_TOKEN }}
    type: plugin
    runtime-zip: dist/my-plugin.zip
```

Gandalf uses that package for runtime investigation in its own environment. A ZIP
of the base revision is not needed. Without a package, Gandalf performs source
review only. A runtime failure preserves the source-review findings.

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `token` | yes | Gandalf API token |
| `type` | yes | `plugin` or `theme` |
| `product-path` | no | Product directory; defaults to `.` |
| `additional-source-paths` | no | Newline-separated shared source paths |
| `base-sha` | outside PRs | Full commit SHA to compare against |
| `runtime-zip` | no | Installable ZIP built from the reviewed checkout |

For events other than pull requests, set `base-sha` explicitly. The target is
always the actual checked-out commit, including GitHub's merge commit when that
is what the checkout step selected. The examples fetch full history so the base
is available locally. With a shallow checkout, fetching a missing base requires
existing Git authentication on the runner.

## Outputs

| Output | Meaning |
| --- | --- |
| `status` | `accepted` or `skipped` |
| `scan-id` | ID of the accepted scan; empty when skipped |
| `accepted-at` | Acceptance time in Unix seconds; empty when skipped |

Acceptance means the scan was queued. The action finishes without waiting for
results. Mission Control handles results and notifications.

## Supported usage and limits

Use a Linux runner with Git and support for Node 24 actions. The runner needs
HTTPS access to `gandalf.wordpress.org`; the action includes its JavaScript bundle
and needs no npm install.

Supported repositories are in github.com/Automattic, github.com/woocommerce and
github.a8c.com/Automattic. For GitHub Enterprise Server, mirror this action to that
host and use its mirrored checkout action. Fork PRs and `pull_request_target`
are unsupported.

The source ZIP contains complete before/after versions of changed regular files.
Unchanged files are excluded; deletions, renames and permission changes remain
explicit. Source ZIPs must fit within 20 MiB compressed. The entire request,
including an optional runtime ZIP, must fit within 512 MiB; each expanded archive
is limited to 1 GiB. Oversized submissions fail without silently discarding files.

## Development

Use Node 24+, `npm ci`, then `npm run verify`. Verification type-checks, rebuilds
the distributed bundle and runs Git/ZIP and submission tests. Include regenerated
`dist/index.js` and `dist/licenses.txt` in changes.

`src/github-scan-contract.ts` is a vendored copy of Gandalf's public wire contract;
synchronize it and the shared fixture deliberately when the contract changes.
See [the boundary record](docs/boundary.md) for implementation details.
