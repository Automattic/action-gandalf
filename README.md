# Gandalf action

Review changes to a WordPress plugin or theme with Gandalf. The action packages
changed source files, submits them and finishes. Gandalf performs the scan and any
runtime investigation, then sends results to Mission Control for presentation and
notifications.

## Single plugin or theme

For a plugin at the repository root, add this workflow to
`.github/workflows/gandalf.yml`:

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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@6a995b2815ed421bdef1604de536858a31fa09ef
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
```

For a theme, change `type: plugin` to `type: theme`. The action compares the
checked-out commit with the PR's base commit. No build is needed for source review.
The job condition skips fork PRs, which this action does not support.

## Monorepo

Set `product-path` to the plugin or theme directory. Invoke the action once per
product; a matrix can scan several products independently:

```yaml
name: Gandalf
on: [pull_request]

permissions:
  contents: read

jobs:
  scan:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    strategy:
      matrix:
        product:
          - plugins/my-plugin
          - plugins/another-plugin
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Automattic/action-gandalf@6a995b2815ed421bdef1604de536858a31fa09ef
        with:
          token: ${{ secrets.GANDALF_API_TOKEN }}
          type: plugin
          product-path: ${{ matrix.product }}
          additional-source-paths: |
            packages/shared
```

`additional-source-paths` is optional: include shared source the product depends
on, or omit it. Paths are literal repository-relative paths, not globs. A product
with no changes in its configured paths is skipped.

## Optional runtime investigation

If your workflow already builds an installable plugin or theme ZIP, pass its path
with `runtime-zip`. Build it from the same checkout being reviewed:

```yaml
- uses: Automattic/action-gandalf@6a995b2815ed421bdef1604de536858a31fa09ef
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
