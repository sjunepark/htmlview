# ADR 0005: Use Node.js, TypeScript, pnpm, and the npm registry

- Status: Accepted; partially superseded by
  [ADR 0007](0007-adopt-effect-v4.md) and
  [ADR 0010](0010-automate-releases-with-release-please.md)
- Date: 2026-07-15

## Context

Version one needs simple global and one-shot installation, reliable detached
process support on macOS and Linux, mature static HTTP primitives, strict
typing, and maintained TOON v3.3 encoding. The package should remain small and
must not acquire a browser runtime dependency. Repository tooling and consumer
distribution are separate concerns: contributors need one reproducible
workflow, while consumers should remain free to use any npm-compatible client.

## Decision

Implement `htmlview` in strict TypeScript targeting Node.js 22.13 or newer and
publish the compiled ESM CLI to the npm registry with an `htmlview` executable.
The registry package identity is `@sjunepark/htmlview`, published publicly; the
unscoped `htmlview` name belongs to an unrelated project. Node's standard
library owns process spawning, loopback HTTP, filesystem, and cryptographic
primitives.

Use pnpm 11, pinned through `packageManager`, for dependency installation,
locking, repository scripts, and packing. ADR 0010 supersedes the publication
boundary with the npm CLI required for trusted publishing. Keep npm installation in
package smoke tests as a consumer-compatibility check rather than a repository
tooling dependency. Use `@toon-format/toon` 2.3.0 at the stdout boundary. Pin
`@toon-format/spec` 3.3.0 as a development dependency and run every official
encoder and decoder fixture, rather than assuming the implementation package's
release number proves specification conformance. Keep Playwright and other
browser controllers development-only or externally installed.

Use TypeScript checking, ESLint, and Prettier. `pnpm run check` is the single
local validation entry point. ADR 0007 supersedes the TypeScript test-runner
and emitted-package details: Effect-aware TypeScript tests use Vitest, and the
published executables are bundled while black-box `.mjs` tests remain on the
Node test runner.

## Consequences

- Consumers can use npm, npx, pnpm, Bun, or another npm-registry client; pnpm
  is not a runtime dependency of the installed CLI.
- The committed `pnpm-lock.yaml` and pinned pnpm version define reproducible
  contributor and CI installs.
- The package validation path creates the release tarball with pnpm, then
  installs and removes that exact artifact with npm on macOS and Linux.
- The supervisor remains a detached invocation of the same installed Node
  artifact, so CLI and daemon versions cannot drift within one package.
- The runtime dependency surface begins with the reference TOON encoder and
  MIME lookup. Effect is bundled into the executables under ADR 0007; browser
  automation stays outside the package.
- Users need a supported Node.js runtime. Release checks exercise both macOS
  and Linux installation and background-process behavior.

## Rejected alternatives

- **npm for repository tooling.** It has the broadest default availability,
  but pnpm provides a stricter dependency layout and a pinned, reproducible
  workflow while leaving npm-registry consumers unaffected.
- **Bun as package manager or runtime.** Its package manager would not improve
  the Node CLI at runtime. Adopting its runtime or standalone executables would
  change process semantics, artifact shape, and the validated distribution
  matrix; that should be evaluated separately if binary distribution becomes a
  product requirement.
- **Go or Rust binary.** Both provide strong static-serving and process
  primitives, but the maintained TOON v3.3 implementation and npm-registry
  one-shot installation would require more owned encoding or packaging
  machinery.
- **Uncompiled JavaScript.** It removes a build step but gives up the strict
  domain and control-message checks that protect the CLI contract.
- **Bundling a browser controller.** It violates the browser-neutral product
  boundary and materially enlarges installation.
