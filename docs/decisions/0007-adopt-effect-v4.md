# ADR 0007: Adopt Effect v4 as the execution model

- Status: Superseded in part by ADR 0009
- Date: 2026-07-15
- Supersedes: ADR 0005's TypeScript test runner and emitted-package details

ADR 0009 replaces this decision's custom-parser and no-Effect-CLI choices and
adds Effect logging. Its execution model, native security-sensitive leaves,
exact pins, packaging policy, and test-runtime decisions remain active.

## Context

The pre-publication implementation has correct serving, confinement, control,
and lifecycle behavior, but fallible asynchronous work is expressed through
Promises, thrown errors, callback bridges, manual retry loops, and several
independent cleanup paths. The supervisor has enough resource ownership and
cancellation-sensitive state that these mechanisms make failure coverage and
shutdown ordering harder to verify than the product warrants.

Effect v4 provides typed failure channels, scopes, interruption, schedules,
runtime schemas, deterministic clocks, and a Node runtime boundary. Version 4
is still prerelease as of this decision, so adoption also needs an exact-version
and distribution policy that prevents silent API drift or an impractical
global CLI install.

## Decision

Use Effect v4 for fallible asynchronous execution and resource lifecycle.
Keep total domain transformations as ordinary TypeScript. Use scopes for
listeners, files, ownership, timers, and background fibers; use typed error
channels for expected operational failures; and use shared Effect schemas to
validate both sides of the private control protocol.

Pin `effect`, `@effect/vitest`, and `@effect/platform-node` to the same exact v4
version. Prefer a stable v4 release when one exists; until then, update the
prerelease only as a deliberate migration slice with source inspection and the
full validation gate. Use package-manager overrides to pin transitive Effect
packages that their publishers reference by range. Pin the Effect language
service exactly as well. Do not allow an Effect package range to advance this
toolchain silently.

Retain the custom command parser and TOON/JSON renderer because their ordering,
help, error, and output contracts were already accepted for that migration.
Retain native Node HTTP,
filesystem, socket, stream, and process adapters at narrow leaves because the
raw byte-serving and confinement behavior is security-sensitive. Use only
`@effect/platform-node/NodeRuntime` from the Node platform package; do not adopt
Effect CLI or an Effect HTTP data plane in this migration.

The parser and Effect CLI clauses above record the Phase 0–9 migration scope
and are superseded by ADR 0009. The native HTTP/data-plane choice remains
active.

Publish two minified, tree-shaken ESM bundles plus linked external source maps
without embedded source content. Store each complete artifact set beneath
`dist/generations/<sha256>/`. The stable package executable `dist/cli.js` is a
two-line activation launcher that imports exactly one generation. This is a
bin-only package with no supported module or type export, so do not ship
declarations for internal modules. Bundle Effect and the Node runtime
integration so a global or one-shot install does not carry Effect's full source
package. Keep `@toon-format/toon` and `mime-types` external as declared runtime
dependencies. The supervisor remains next to its matching CLI bundle so
detached-process discovery cannot cross generations. Ship notices for every
bundled dependency and fail the build if that set or the external import
contract drifts.

Build both bundles and their maps in a unique staging directory, validate the
complete staged result, derive its content address, then serialize publication
into `dist`. Rename the immutable generation into place before atomically
replacing the launcher. A crash before activation leaves the old generation
selected; a crash afterward selects the complete new generation. Concurrent
builders can install the same verified content address, and the last atomic
launcher replacement wins without mixing artifacts, so publication needs no
lock or stale-lock recovery. Retain older generations because a CLI process
that started before activation must still be able to spawn its matching
supervisor. Package builds require a quiescent clean checkout containing only
the activated generation so the published file set remains exact and
reproducible. Keep installation and activation behind one publication module;
an injected internal pre-activation seam provides deterministic failure and
distinct-generation concurrency validation without production flags.

Use Vitest with `@effect/vitest` for TypeScript unit and integration tests so
scoped tests and `TestClock` are first-class. Keep black-box `.mjs` lifecycle
tests on Node and browser validation on Playwright. Configure the Effect
language-service plugin and run its diagnostics explicitly during typecheck;
do not add a package lifecycle hook that would patch a consumer's TypeScript
installation.

## Consequences

- Expected failures and resource requirements become visible in function
  signatures, while defects remain distinct from caller-correctable errors.
- The supervisor and each content session can have one explicit, nested
  ownership tree with reverse-safe finalization.
- Retry and idle policies can be tested with a deterministic clock without
  weakening real socket deadlines.
- Beta upgrades require deliberate source/API verification and complete
  validation rather than an ordinary range resolution.
- Bundling adds a build step and bundled license/source-map obligations, but
  keeps the installed runtime dependency surface and executable startup
  practical.
- The bundle duplicates the runtime between two standalone executables and is
  materially larger than the Promise artifact; this preserves detached
  discovery without adding a shared-chunk installation contract.
- Internal modules are no longer available as emitted JavaScript artifacts;
  validation must exercise source-level seams or the built CLI rather than
  importing undocumented files from `dist`.

## Rejected alternatives at the time

- **Delay Effect until after publication.** This would publish the Promise
  lifecycle as the first supported architecture and make the later migration a
  compatibility exercise rather than a pre-release implementation decision.
- **Ship Effect as an unbundled runtime dependency.** Phase 0 measurements
  showed that two bundles preserve the detached entry and avoid installing the
  full Effect package surface for this CLI.
- **Adopt Effect CLI or HTTP abstractions.** Their contracts differ from the
  accepted AXI syntax and native raw-server behavior, expanding migration risk
  without solving the ownership problem.
- **Wrap every Node or pure helper in a service.** This would enlarge the
  dependency graph without creating meaningful ownership or test seams.
- **Patch TypeScript in `prepare` or `postinstall`.** A published CLI must not
  mutate a consumer's compiler installation, and explicit repository
  diagnostics provide the required build-time check.
