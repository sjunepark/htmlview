# ADR 0010: Automate releases with Release Please and npm trusted publishing

- Status: Accepted
- Date: 2026-07-18
- Partially supersedes:
  [ADR 0005](0005-use-node-typescript-pnpm-and-the-npm-registry.md)

## Context

The package needs repeatable SemVer classification, reviewable release notes,
immutable tags, and npm publication without a long-lived registry credential.
GitHub workflow-created tags and releases do not reliably trigger a second
workflow when the repository token created them. npm trusted publishing also
requires an existing registry package, so the first publication cannot use the
same OIDC relationship as later releases.

## Decision

Use Release Please in manifest mode for the single root Node package. Release
Please owns version changes, the version manifest, changelog, release PR, tag,
and GitHub release. Conventional Commits provide release inputs, but reviewers
classify impact against the public CLI and runtime contracts before merging a
release PR. The initial version is explicitly `0.1.0`; later versions follow
the configured Release Please SemVer behavior without a custom pre-1.0 policy.

Run npm publication as a conditional job in the same workflow invocation that
creates the GitHub release. The job checks out the Release Please output SHA,
repeats the automated release gates, and uses the npm CLI's GitHub Actions OIDC
support. The `npm` GitHub environment and exact workflow filename are part of
the trusted-publisher identity. No long-lived npm write token is stored.

Bootstrap `@sjunepark/htmlview@0.1.0` once with interactive npm authentication
and 2FA because npm cannot configure a trusted publisher for a package that
does not yet exist. Bind the package to the OIDC workflow immediately afterward.
The publish step is idempotent for that bootstrap rerun and never overwrites an
existing registry version.

## Consequences

- Release Please-generated versions, manifests, changelogs, tags, and release
  notes are not edited manually.
- Merging a release PR is the explicit promotion decision; publication follows
  only after validation of the exact release commit.
- Routine publication has npm provenance and no reusable registry secret.
- The external Browser Use release check remains manual because browser control
  is intentionally outside the repository and hosted CI artifact.
- ADR 0005's pnpm tooling choice remains active for dependency management,
  scripts, and packing. The npm CLI now owns only the trusted publication seam.

## Rejected alternatives

- **Permanent npm automation token.** It creates a reusable write credential
  and weakens 2FA compared with workflow-bound OIDC.
- **Separate publish-on-release workflow.** A release created with the default
  workflow token may not emit the event needed to start it.
- **Manual version, changelog, tag, and release management.** It duplicates the
  state machine Release Please already makes reviewable and repeatable.
- **Bundling browser-use into hosted CI.** It would blur the deliberate external
  browser-controller boundary and would not reproduce the maintained local
  Chrome/CDP acceptance environment.
