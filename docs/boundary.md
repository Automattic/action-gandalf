# Gandalf action boundary

## Boundary symptom

The existing platform-workflows hello-world pilot proves target checkout and
per-product jobs, but does not prove Gandalf installation, AI authentication,
CTRF handling, or availability of SecEx in this new repository.

## Native shape

A composite action installs a pinned CLI and runs a subprocess on a directory.
The workflow selects the runner, checks out products, and uploads reports.
Gandalf owns scan semantics, coverage, model routing, and CTRF production.

## Capability policy

Product files are scan inputs. Their install scripts and application code are
never run by the integration. Source-read credentials belong only to checkout;
the OpenRouter key belongs only to scanning. Source, caches, configuration, and
reports stay outside the product directory. Secrets are not artifacts.

## Current abstraction

There is no action to patch. Avoid a server, proxy, container registry, or a
second report format. The standalone action does not depend on platform-workflows.

## Plane separation

The caller owns inventory, repository authentication, and execution placement.
The action owns installation and subprocess handling. Gandalf owns analysis.
The caller retains the original evidence as a private Actions artifact.

## Standard/native option

Use pinned first-party checkout and runtime setup actions mirrored in the local
`github.a8c.com/actions` organization, native GitHub secret
access controls, the CLI's `--json` surface, and the GHES-supported artifact
uploader. Keep required full-SHA pinning enabled.

## Small patch option

Copying the platform executor would couple this integration to its inventory,
PHP helpers, and audit state. It does not address private CLI authentication or
the subprocess result contract. Do not copy that executor.

## Decision

Use a small composite action and direct subprocess contract. Exit 0/1 means the
scan completed; 2/3 or abnormal termination means execution failed. Validate
CTRF using its reference parser, preserve bytes, and never infer complete
coverage from zero findings. Keep OpenRouter authentication as an org secret;
runner exposure is the explicitly accepted v1 model.

## Proof

Question: can this repository provision SecEx, fetch the private pinned CLI,
build and warm prompt-security, authenticate a real model request, and retain
the exact report?

Facts: source revision `7e61c567db67d82e3c8cf29773fc76516b1deefc`
requires Node >=24.14.0, has local `../contracts` dependencies, builds the pinned
Linux x64 YARA tool, and compiles Enry with Go. `scan --json` emits CTRF and
current exit codes are 0/1/2/3. The CLI's `.nvmrc` is stale (Node 22); package
engines and ADR 039 govern the runtime. This new repository currently requires
SHA pins and initially permits local actions only.

Verified local mirrors: checkout, setup-node, setup-go, and upload-artifact.
All four pinned commits exist on GHES. The Node setup pin is the mirrored
v7.0.0 release (`820762786026740c76f36085b0efc47a31fe5020`); the initially
chosen upstream main commit was absent from the mirror. The organization
requires `local_only`; no policy relaxation is needed or applied. Third-party
actions are mirrored separately under `third-party-actions`, but this pilot
does not need them.

Unproven: SecEx provisioning here, runtime action execution,
download egress, cold Go build time, private read-token access, OpenRouter
authentication, and GHES artifact upload.

Start with a disposable manual runner/runtime/artifact proof, then add private
source build and scans of Page Optimize and Blank Canvas 3. Record versions,
revisions, commands, timing, output, and statuses. Page Optimize must show a
completed provider request; Blank Canvas 3 has no PHP/JS and only proves its
applicable coverage and theme checkout.

Step debugging of GitHub's scheduler is unavailable; job/step records and real
artifacts directly prove that boundary. Inspect the compiled CLI with Node's
inspector if a scan or output decision differs from its documented contract.

Promote only after the real boundary is understood and focused subprocess
tests pass. Delete the disposable workflow when the permanent pilot succeeds.
Expected external failures fail visibly; do not add alternate authentication,
runtime versions, generic retry layers, or report reconstruction.

Cross-boundary risks: exit/status drift is locked by fixtures for 0/1/2/3 and
abnormal termination; CTRF shape is validated with the reference parser;
credential separation is checked at the subprocess boundary. Coverage and
model-call evidence use Gandalf's emitted fields, never finding counts as a
proxy. AIM, scheduled scans, GitHub.com publication, and additional scanners
are deferred.
