# ADR 0005: Use Node.js, TypeScript, and npm packaging

- Status: Accepted
- Date: 2026-07-15

## Context

Version one needs simple global and one-shot installation, reliable detached
process support on macOS and Linux, mature static HTTP primitives, strict
typing, and maintained TOON v3.3 encoding. The package should remain small and
must not acquire a browser runtime dependency.

## Decision

Implement `htmlview` in strict TypeScript targeting Node.js 22.13 or newer and
publish the compiled ESM CLI through npm with an `htmlview` executable.
Node's standard library owns process spawning, loopback HTTP, filesystem, and
cryptographic primitives.

Use `@toon-format/toon` 2.3.0 at the stdout boundary. Pin
`@toon-format/spec` 3.3.0 as a development dependency and run every official
encoder and decoder fixture, rather than assuming the implementation package's
release number proves specification conformance. Keep Playwright and other
browser controllers development-only or externally installed.

Use the Node test runner through `tsx`, TypeScript checking, ESLint, and
Prettier. `npm run check` is the single local validation entry point.

## Consequences

- `npm install --global htmlview` and `npx htmlview` are natural distribution
  paths once the package is published.
- The supervisor can be a detached invocation of the same installed artifact,
  so CLI and daemon versions cannot drift within one package.
- The runtime dependency surface begins with only the reference TOON encoder;
  browser automation stays outside the package.
- Users need a supported Node.js runtime. Release checks must exercise both
  macOS and Linux installation and background-process behavior.
- Published packages contain compiled output and user documentation, not the
  development browser suite.

## Rejected alternatives

- **Go or Rust binary.** Both provide strong static-serving and process
  primitives, but the maintained TOON v3.3 implementation and npm one-shot
  installation would require more owned encoding or packaging machinery.
- **Uncompiled JavaScript.** It removes a build step but gives up the strict
  domain and control-message checks that protect the CLI contract.
- **Bundling a browser controller.** It violates the browser-neutral product
  boundary and materially enlarges installation.
