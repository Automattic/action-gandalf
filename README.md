# Gandalf action

Submit changes to a WordPress plugin or theme for an asynchronous Gandalf scan.
The action packages committed Git source, receives a scan ID and exits. Gandalf
delivers the result to Mission Control, which owns presentation and notifications.

This implementation needs the matching Gandalf GitHub intake deployed and its MC
callback configured. A real hosted/SecEx run is also required before rollout.

## Usage

Check out the revision to review, then call this action. Replace `ACTION_COMMIT`
with the reviewed full commit SHA after publication. On GHES, mirror this repository
to `github.a8c.com/Automattic/action-gandalf`; `uses` resolves against that host.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    with:
      fetch-depth: 0
      persist-credentials: false
  - uses: Automattic/action-gandalf@ACTION_COMMIT
    id: gandalf
    with:
      token: ${{ secrets.GANDALF_API_TOKEN }}
      type: plugin
      product-path: plugins/example
      additional-source-paths: |
        packages/shared
```

Use `type: theme` for a theme. `product-path` defaults to `.` for a single-product
repository. Invoke once per product in a monorepo. Shared paths are optional,
literal repository-relative paths, not globs. Every changed regular file in scope
is packaged; Gandalf retains its normal review eligibility and coverage reporting.

On a PR the comparison base defaults to the PR base SHA. Elsewhere set `base-sha`
to a full commit SHA. The review target is always `git rev-parse HEAD`, which can be
GitHub's PR merge commit. Both that SHA and PR head identity are retained. Full
history checkout makes the baseline available without another authenticated read;
with a shallow checkout, the action fetches the exact base if absent using the
caller's existing Git authentication. The action does not create checkout tokens.

For runtime investigation, build an installable ZIP in the caller's workflow from
that same checkout, then add `runtime-zip: dist/example.zip`. Build commands and
artifact layout are product-owned; no baseline build is needed. Omit the input for
source-only review. Gandalf records runtime failure separately and preserves static
findings. The supplied build identity is trusted caller metadata, not attestation.

## Inputs and outputs

| Input | Required | Meaning |
| --- | --- | --- |
| `token` | yes | Dedicated org `GANDALF_API_TOKEN` |
| `type` | yes | `plugin` or `theme` |
| `product-path` | no | Product path, default `.` |
| `additional-source-paths` | no | Newline-separated shared source paths |
| `base-sha` | outside PRs | Full baseline commit SHA |
| `runtime-zip` | no | Installable package built from the actual checkout |

`status` is `accepted` or `skipped`; `scan-id` and Unix-second `accepted-at` are empty
when no scoped changes exist. Acceptance is not a verdict or completed scan.
The action does not wait for results or post a GitHub comment.

## Payload and credentials

The action uploads full before/after bytes of changed regular files, with a versioned
Git manifest. Unchanged files never enter the ZIP. Additions, deletions, renames,
permission changes and type changes remain explicit. Symlinks and gitlinks are
metadata only. Source ZIPs above 20 MiB compressed fail; no silent truncation or
alternative representation is used. Source plus optional runtime ZIP must fit a
512 MiB request; expanded archives are limited to 1 GiB each.

`GANDALF_API_TOKEN` is the only scanning secret required on callers. Set it as an
organization secret for selected trusted repositories in github.com/Automattic,
github.com/woocommerce and github.a8c.com/Automattic. A workflow with this secret can
read it; this design is not non-exfiltratable. Fork PRs and `pull_request_target`
are rejected in v1. Do not introduce a privileged workflow that executes untrusted
PR code before passing it secrets.

No OpenRouter key, private CLI read token or outgoing MC token belongs in this
action. The Gandalf endpoint is fixed; the server owns the callback URL. Requests
do not follow redirects. Transient failures retry at most three times using the
same invocation UUID and source files. A workflow rerun creates a new invocation.

The runner needs Linux, Git, a GitHub Actions runner supporting Node 24 actions,
and HTTPS egress to `gandalf.wordpress.org`. No npm install is needed to use the
action: its bundled `dist/index.js` is committed with source. Confirm mirrored
checkout/setup action pins exist on GHES before enabling its workflow.

## Development

Use Node 24+, `npm ci`, then `npm run verify`. Verification type-checks, rebuilds the
distributed bundle and runs real Git/ZIP and retry tests. Include the regenerated
`dist/index.js` and `dist/licenses.txt` in changes. `src/github-scan-contract.ts` is an exact vendored copy
of Gandalf's `contracts/src/github-scan.ts`; synchronize it and the shared fixture
deliberately when the wire contract changes.

See [the boundary record](docs/boundary.md) and the matching Gandalf
`server/docs/github-scans.md` for the HTTP and MC callback contract.
