# Asynchronous GitHub boundary

The action owns a native Git comparison, changed-file packaging and authenticated
submission. The caller owns checkout and builds. Gandalf's server owns intake,
durable queueing and callback delivery; its CLI owns AI review and investigation.
Mission Control owns storage/presentation and notifications.

The earlier local-CLI/SecEx bootstrap is superseded. No private scanner clone,
runtime installation or model-provider credential is needed on the runner.

## Representation

Use `git diff --raw -z --no-abbrev --find-renames=50%` with literal pathspecs and
`git cat-file blob` to capture exact committed bytes. Do not read source from the
worktree or follow Git symlinks. Keep actual checkout identity distinct from PR
head and base. One UTF-8 ZIP manifest carries complete changed regular file versions
and explicit link/gitlink metadata. Empty before/after sides are valid.

Source has one fixed 20 MiB compressed bound. A separate caller-built runtime ZIP
is optional. Native ZIP/multipart streams bound local memory; every receiving
boundary validates content hashes, exact membership and archive limits.

## Authorization and delivery

Trusted repositories receive an org bearer token. Host/org metadata is an assertion
by that authorized caller; this is not OIDC or build attestation. The production
endpoint is fixed and redirects are rejected. MC callback authorization is a
separate server-owned credential that is never sent to the action.

Generate one UUID per invocation and reuse it across bounded network/429/5xx retries.
Gandalf returns 202 only after durable publish and queue insertion. Reuse with a
different payload returns 409. An accepted scan produces one frozen terminal
callback, with exact CTRF bytes plus digest for completed scans. MC deduplicates
delivery by scan ID. An action rerun is intentionally a new scan.

## Evidence and rollout

The disposable Git/ZIP proof established exact edit/add/delete/rename/mode records,
unusual filenames and metadata-only links. The original package reviewer omitted
deletions and mode-only changes, so Gandalf now uses an explicit GitHub ruleset.
Tests exercise real Git repositories, SHA-1/SHA-256 identities, unchanged/worktree
exclusion, compressed oversize and HTTP retry identity. Server/CLI tests share
`github-changes.json`, validate deletion review, archive rejection, durable restart,
full callback retention, runtime input separation and runtime-failure preservation.

The experiments were promoted into these narrow contracts and tests; disposable
scripts are not shipped. Exact input/output and branch assertions make stepping
through Git or the ZIP library unnecessary for these deterministic cases.

Before release: deploy matching Gandalf server/worker; configure MC URL/token with
Systems; provision the incoming org token; publish a reviewed action commit and
mirror it to GHES. Run one trusted plugin and theme through actual hosted/SecEx
runners and confirm MC acknowledgement. Local tests do not prove ingress limits,
runner egress, GitHub token policy, model quality or production runtime capacity.

AIM, fleet scheduling, general-code targets, fork handoff, late artifacts and
fallback payload representations remain out of scope.
