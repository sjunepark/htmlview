# Effect v4 Adoption Plan

- Status: In progress; Phase 8 complete
- Updated: 2026-07-15
- Parent plan: [`PLAN.md`](../../PLAN.md)
- Decision scope: migrate htmlview's fallible asynchronous execution and
  resource lifecycle to Effect v4 before the first package publication

## Objective

Adopt Effect v4 as htmlview's execution model while preserving every accepted
product, security, CLI, HTTP, lifecycle, and packaging contract. The migration
must improve typed failure handling, resource safety, cancellation, retry
policy, deterministic testing, and protocol validation without replacing the
proven raw-serving algorithms or expanding the public interface.

The finished implementation should have one clear production path:

- pure domain and path functions remain ordinary TypeScript;
- fallible asynchronous operations return `Effect.Effect` with explicit error
  and service requirements;
- long-lived resources are acquired and released through scopes;
- control messages are decoded and encoded through shared Effect schemas;
- the custom command parser and TOON/JSON renderer remain authoritative; and
- Node-specific filesystem, HTTP, stream, socket, and process primitives remain
  at narrow leaf adapters where their exact behavior is required.

## Definition of done

The migration is complete only when all of the following are true:

- `effect` v4 is pinned to one exact prerelease or stable version across all
  Effect packages; no Effect version range can silently advance.
- Expected operational failures are present in Effect error channels and map
  exhaustively to the existing stable public error codes.
- Defects are reserved for bugs and violated invariants; broad catches do not
  turn unknown defects into misleading operational failures.
- Supervisor ownership, session listeners, control listeners, open files,
  timers, and background fibers have explicit scoped lifetimes.
- Cancellation cannot strand a transferred ownership lock, publish an unready
  session, or leave a partially committed registry mutation.
- The client and server validate the same control-protocol schemas at runtime.
- The existing CLI accepts the same argument ordering and emits logically
  equivalent TOON/JSON values, errors, help, and exit codes.
- Raw `GET` bodies remain byte-for-byte identical to source files, and all
  confinement, authority, and symlink-race tests still pass.
- TypeScript unit and integration tests use one Effect-aware test runner;
  black-box `.mjs` E2E and browser validations may remain on Node/Playwright.
- The installed package remains practical for a one-shot/global CLI. Release
  evidence records tarball size, installed size, and cold-start impact, with a
  bundling decision made from that evidence.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md), the relevant ADRs, this file, and
  [`PLAN.md`](../../PLAN.md) describe the implemented state rather than the
  intended migration.
- `pnpm run check`, Linux package validation, Browser Use validation, and the
  security validation applicable to the touched paths all pass.

## New-session kickoff

Start a fresh implementation session with:

> Use `$progress-run` to execute
> `docs/plans/effect-v4-adoption.md`. Start at the first incomplete phase, keep
> this file updated in place, preserve every repository invariant, and stop at
> any explicit decision gate that cannot be resolved from repository evidence.

Before editing, the new session must:

1. Read `AGENTS.md`, [`docs/PRODUCT.md`](../PRODUCT.md),
   [`docs/CLI.md`](../CLI.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md),
   [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md), [`PLAN.md`](../../PLAN.md),
   ADR 0005, ADR 0006, and this file.
2. Run `git status --short` and treat all existing changes as intentional.
3. Run `effect-solutions --version`, `effect-solutions list`, and:

   ```sh
   effect-solutions show project-setup tsconfig basics data-modeling \
     error-handling services-and-layers testing cli
   ```

4. Resolve current dist-tags with `npm view effect dist-tags --json`. Prefer a
   stable v4 release when available; otherwise use the current v4 beta. Inspect
   the installed package source for every API used. Do not rely on remembered
   v3 names or copy the version recorded by an earlier session.
5. Use the canonical [`Effect-TS/effect`](https://github.com/Effect-TS/effect)
   repository. The older `effect-smol` repository is archived.
6. Establish or confirm the baseline in Phase 0 before changing dependencies.

## Progress protocol

- Work in phase order. A phase may be split into smaller coherent commits, but
  do not begin the next phase until its exit criteria pass.
- Keep at most one phase marked `In progress` in the status table.
- After each coherent slice, update the current phase, validation evidence,
  decisions, blockers, and single next action in this file. Replace stale
  evidence instead of appending session transcripts.
- Run the repository's required code-review workflow after every reviewable
  implementation slice. Apply obvious safe findings and revalidate.
- Do not preserve parallel Promise and Effect production implementations as a
  compatibility layer. Test-boundary `Effect.runPromise` adapters are allowed
  while a phase is in progress and must be removed when no longer needed.
- If a v4 API has changed, inspect the installed declaration/source and update
  the plan before proceeding. Do not solve API churn with `any`, unchecked
  casts, or broad wrappers.

## Non-negotiable boundaries

### Preserve

- The serving root remains the complete explicit read-disclosure grant.
- The raw route never transforms HTML, assets, headers in behavior-changing
  ways, or source files.
- Every content listener binds only to `127.0.0.1` and validates the exact
  random `.localhost` host and port.
- Control remains on the user-private Unix-domain socket with lifetime-lock
  ownership and no persisted bearer credential.
- Ready-before-output, idempotent serve/stop, the 32-session bound, idle
  shutdown, and versioned control semantics remain unchanged.
- Stdout contains only structured domain results/errors; diagnostics stay on
  stderr.
- Browser automation and browser installation remain external dependencies.

### Do not introduce

- `effect/unstable/cli`; its parsing/help behavior is not the htmlview CLI
  contract.
- An Effect HTTP abstraction in place of the raw data-plane listener unless a
  separate fidelity and threat-model review proves exact equivalence.
- A generic wrapper for every Node module, pure helper, or value.
- OpenTelemetry exporters, remote telemetry, a plugin system, public binding,
  annotation work, new CLI flags, or new output fields.
- Automatic retry of non-idempotent or ownership-changing operations.
- `Effect.orDie` for failures that the caller can correct.

## Current baseline

The pre-migration implementation is approximately 2,738 source lines and 2,058
TypeScript test lines. Its Effect-shaped complexity is concentrated in:

| Concern                                    | Current owner                               | Migration opportunity                                    |
| ------------------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| Command dispatch and error rendering       | `src/app.ts`, `src/service.ts`              | Typed application error channel and exhaustive rendering |
| Grant filesystem failures                  | `src/serving/grant.ts`                      | Typed path failures around otherwise plain path logic    |
| Open-file lifetime                         | `src/serving/http.ts`                       | Scoped handles while retaining native streaming          |
| Control protocol validation                | `src/supervisor/protocol.ts`, client/server | Shared schemas and derived types                         |
| Health/start/stop retry loops              | `src/supervisor/client.ts`                  | `Schedule`, `Clock`, and interruption                    |
| Ownership lock and temporary files         | `src/supervisor/state.ts`                   | Scoped acquisition and guaranteed cleanup                |
| Registry serialization and session cleanup | `src/supervisor/server.ts`                  | Effect synchronization and child scopes                  |
| Idle shutdown and signals                  | supervisor server/main                      | Scoped fibers and one shutdown path                      |

Baseline evidence from Phase 0:

- Baseline commit: `99f950b24a310683926d1dd5a1f9e84288f7f025`;
  pre-existing working tree was `M PLAN.md` and `?? docs/plans/`.
- Platform: macOS 26.5.1 arm64; Node 24.15.0; pnpm 11.13.0.
- `pnpm install --frozen-lockfile` and `pnpm run check`: passed; 89
  TypeScript tests, the black-box E2E test, 7 Playwright checks, and current
  package lifecycle validation were green.
- Pre-migration package: 77,330-byte tarball, 61 packed files, 840 KiB and 78
  files installed including runtime dependencies.
- Process-spawn samples from the installed tarball: `--version --json` median
  65.36 ms over 11 runs; empty `--json` against a fresh supervisor median
  84.23 ms over 7 runs. These are local wall-clock medians, not benchmarks.
- `pnpm run validate:browser-use`: passed with Browser Use 0.1.5 and the
  complete fixture. `pnpm run validate:package:linux`: passed with Docker
  28.4.0 and the Node 22 Bookworm image.

## Effect v4 source and version policy

Effect v4 is currently distributed through the `beta` tag, but this plan must
remain usable after stable release. At the start of each dependency-update
slice:

1. Query the dist-tags for `effect`, `@effect/vitest`, and any selected platform
   package.
2. Prefer stable v4 packages when available; otherwise select one matching v4
   beta version. Pin every selected package exactly in `package.json` and the
   lockfile.
3. Verify peer dependencies before installation.
4. Inspect exports and declarations from the installed package, especially for
   `Scope`, interruption, synchronization, `Schedule`, `Schema`, test-clock,
   runtime-main, and unstable modules.
5. Record the chosen versions and source commit/tag in the decision log below.

Use stable core entry points whenever possible. An `effect/unstable/*` import
requires all three of:

- no stable core or narrow Node implementation can meet the requirement;
- an explicit entry in the decision log explaining the dependency; and
- focused contract tests that would fail on semantic drift.

Follow the installed `effect-solutions` guidance for idioms, with two local
overrides:

- translate its Bun commands to the repository's pinned pnpm workflow; and
- use the canonical Effect repository rather than its older `effect-smol`
  setup reference.

## Target design

### Execution rule

Use `Effect.Effect<Success, Failure, Requirements>` for fallible asynchronous
operations. Keep synchronous, total transformations as ordinary functions.
Do not wrap `path.relative`, command parsing, header construction, ETag
calculation, or JSON-compatible result assembly merely to make them Effects.

Use `Effect.fn` for named orchestration operations where traces clarify a
cross-module call. Avoid naming tiny one-expression effects solely for style.

### Service and Layer rule

Create a service only when it forms a deep responsibility boundary, owns a
resource, or has a real test substitute. Expected candidates are:

- command operations consumed by the app;
- the supervisor control client;
- the session-server factory used by the registry; and
- process launch or app I/O if test substitution remains necessary.

Pure modules, schemas, error definitions, and one-off Node calls do not need a
service. Dependencies belong in Layer construction, and the complete
production Layer is provided once at each executable entry point.

### Error model

Model errors by recovery boundary, not one class per throw site. A reasonable
starting union is:

- path/grant failure;
- runtime-state/ownership failure;
- control transport or protocol failure;
- supervisor lifecycle failure; and
- content-listener startup/readiness failure.

Each expected error must carry:

- a category `_tag` for internal exhaustive handling;
- the existing stable public `code` literal;
- a safe user-facing message; and
- only the structured details needed by the CLI renderer.

Wrap unknown Node/library failures as a cause/defect field only inside the
internal error value. Never serialize raw stacks, paths beyond the existing
contract, or arbitrary exception text to stdout. The app boundary renders
expected tagged failures and maps an unexpected cause to `runtime.internal`.

### Protocol schemas

`src/supervisor/protocol.ts` becomes the single source of truth for control
requests, successful responses, structured control errors, session summaries,
and supervisor identity. Derive TypeScript types from schemas rather than
maintaining parallel interfaces.

Schemas must enforce existing bounds and exact shapes, including:

- protocol/version/instance/PID identity;
- session status, URL, route entry, root, and optional selected fields;
- create/list/stop/shutdown request bodies and query selections;
- maximum response/body assumptions; and
- stable error-code values.

Both control endpoints decode untrusted input, and the client decodes every
response before using it. Add adversarial tests for extra/missing keys, wrong
types, oversized values, invalid identifiers, invalid URLs, and version
mismatch.

### Resource hierarchy

The intended ownership tree is:

```text
CLI invocation scope
  supervisor client operations
  bootstrap ownership lock, only until transfer or release

supervisor process scope
  authoritative ownership lock
  private control listener
  idle-shutdown fiber
  session registry
    session child scope
      raw content listener
      request fibers / file handles for that listener
```

Acquisition and release must be registered in reverse-safe order. A session is
added to the visible registry only after its listener passes readiness. Failed
creation closes its child scope before returning an error. Targeted stop closes
exactly one child scope; shutdown prevents new mutations, closes every session,
closes control, and releases ownership exactly once.

### Interruption and atomicity

Long waits, sleeps, readiness probes, response reads, and shutdown waits should
be interruptible. Ownership transfer, registry commit/removal, temporary-file
rename, and other short state transitions must use an uninterruptible region or
equivalent masking so cancellation cannot expose a half-applied state. Restore
interruptibility around blocking network/filesystem waits inside a masked
operation.

Native socket timeouts may remain native where they enforce Node HTTP limits.
Effect schedules must not weaken existing absolute deadlines or retry counts.

### Native HTTP boundary

Retain the existing Node request/response and file-stream behavior. Effect may
own listener acquisition, file-handle cleanup, request-fiber supervision, and
typed filesystem failures. Do not buffer ordinary response bodies, transform
streams, infer index routes, or replace the existing open/stat/realpath
confinement sequence without separate adversarial evidence.

When bridging callbacks, attach request work to the owning session runtime and
scope. Do not call an unmanaged `Effect.runPromise` per request or allow handler
fibers to outlive listener shutdown.

### Testing topology

Use Vitest plus `@effect/vitest` for `test/**/*.vitest.ts`. Use `it.effect` or
`it.scoped` for Effect programs and test Layers for replaceable leaf services.
Use `TestClock` for schedule, retry, idle-shutdown, and timeout policy tests
that do not need real sockets. Keep real time for black-box process/socket tests
whose purpose is operating-system behavior.

Keep `test-e2e/**/*.mjs` on Node's test runner and browser suites on Playwright.
Do not retain two TypeScript unit-test runners after the migration.

## Phase status

| Phase                                | Status   | Exit summary                                           |
| ------------------------------------ | -------- | ------------------------------------------------------ |
| 0. Baseline and API verification     | Complete | Green baseline and recorded v4/package decisions       |
| 1. Decision records and toolchain    | Complete | Exact dependencies, diagnostics, build/test skeleton   |
| 2. Errors and protocol schemas       | Complete | Shared runtime-validated control contract              |
| 3. Runtime-state and lock lifecycle  | Complete | Typed, interruption-safe private state operations      |
| 4. Grant and raw-server resources    | Complete | Scoped serving resources with byte fidelity intact     |
| 5. Supervisor registry and server    | Complete | Scoped sessions, control work, and idle shutdown       |
| 6. Supervisor client                 | Complete | Cancellable, scheduled, scope-safe client lifecycle    |
| 7. App services and entry points     | Complete | One Effect runtime path for both executables           |
| 8. Test-suite migration              | Complete | One Effect-aware runner and deterministic policy tests |
| 9. Packaging, docs, and release gate | Pending  | Full validation and release-ready artifact             |

## Phase 0: Baseline and API verification

### Work

- Record the baseline commit, platform, Node version, pnpm version, and clean or
  pre-existing working-tree state.
- Install with `pnpm install --frozen-lockfile` and run `pnpm run check`.
- Run `pnpm run validate:browser-use` and
  `pnpm run validate:package:linux` when their external prerequisites are
  available; otherwise record the exact blocker.
- Produce the current tarball through the existing package validation path and
  record packed size, installed size, file count, and representative cold
  starts for `htmlview --version --json` and an empty home invocation.
- Resolve the current matching v4 beta packages and inspect their installed
  sources/declarations.
- Make a minimal throwaway build spike outside tracked source that confirms:
  Node 22 ESM operation, source maps, scoped server cleanup, test-clock support,
  and whether the two executable entry points can be bundled without dynamic
  path breakage.
- Decide whether production uses core `effect` alone or also
  `@effect/platform-node`. Add the platform package only for concrete runtime
  or adapter value; do not adopt its HTTP/filesystem abstractions by default.
- Decide the package form. The default preference for this globally installed
  CLI is two tree-shaken ESM bundles (CLI and supervisor) plus declarations,
  so consumers do not install the full Effect source package. Keep an
  unbundled dependency only if measured release evidence is clearly better.

### Validation

- Existing baseline suite is green or its pre-existing failures are recorded.
- The spike starts and stops a scoped Node server without open-handle leakage.
- The chosen build retains a stable supervisor entry path for detached spawn.
- Version and packaging decisions are recorded below.

### Exit criteria

No production file has been migrated, and every dependency/build decision
needed by later phases has evidence rather than assumption.

## Phase 1: Decision records and toolchain

### Work

- Add ADR 0007 recording Effect v4 as the execution model, its beta pinning
  policy, retained native data plane/custom CLI, package form, and superseded
  parts of ADR 0005.
- Amend ADR 0005 only where its consequences would otherwise contradict the
  new decision; keep its Node, pnpm, npm-registry, and browser-neutral choices.
- Add exact matching Effect dependencies. If production bundles Effect, keep
  build/test packages in `devDependencies` and verify the tarball has no
  undeclared runtime import.
- Add the exact compatible Effect language-service package and `tsconfig`
  plugin. Translate setup commands to pnpm. Verify any patch/prepare lifecycle
  against packed consumer installation before keeping it.
- Add Vitest and `@effect/vitest` configuration without migrating all tests
  yet. Ensure the existing suite can continue during this phase.
- Add the chosen bundle/declaration build pipeline if Phase 0 selected it.
- Add a small compile-time/runtime smoke test covering a tagged error, schema
  decode, scoped finalizer, and test clock.

### Validation

- `pnpm install --frozen-lockfile`
- `pnpm run typecheck`
- Effect smoke test
- `pnpm run build`
- `pnpm run validate:package`
- `git diff --check`

### Exit criteria

The repository has a reproducible Effect-aware toolchain, no public behavior
has changed, and packed installation still starts both executable entry paths.

## Phase 2: Errors and protocol schemas

### Work

- Introduce the minimal tagged-error module or colocated definitions needed by
  the recovery boundaries above. Preserve all existing public error codes.
- Replace hand-maintained protocol interfaces in
  `src/supervisor/protocol.ts` with schemas and derived types.
- Add explicit decode/encode functions used by both client and server. Avoid
  generic `requiredRequest<T>` casts that trust unvalidated JSON.
- Model session identifiers and supervisor instance identifiers as branded
  values if branding prevents real mix-ups. Do not brand arbitrary strings
  without a validation or confusion boundary.
- Add exhaustive public-error rendering and compile-time exhaustiveness tests.
- Add protocol conformance/adversarial tests before changing transport logic.

### Validation

- Focused protocol and output tests
- TOON/JSON logical-equivalence tests
- `pnpm run typecheck`
- `pnpm run lint`

### Exit criteria

One schema set owns the control contract, decoded values require no unchecked
cast, and public output remains unchanged.

## Phase 3: Runtime-state and lock lifecycle

### Work

- Keep `statePaths`, path calculations, and liveness predicates pure.
- Convert private-state directory checks and writes to typed Effects.
- Bracket every opened descriptor and temporary file. Cleanup failure must not
  mask the primary failure, but it must remain observable in the cause/log.
- Convert ownership acquisition polling to `Clock`/`Schedule` while preserving
  the current timeout, stale-owner rules, inode/device fencing, nonce checks,
  and 50 ms observation cadence unless tests justify a change.
- Represent acquired ownership as a scoped resource whose finalizer releases
  only when the nonce still matches.
- Make ownership transfer atomic with respect to interruption. The bootstrap
  owner must either transfer successfully or release its claim.
- Add deterministic tests for timeout/retry policy and real-filesystem tests
  for ownership fencing and stale-lock recovery.

### Validation

- Focused state/lock tests under TestClock where possible
- Existing simultaneous recovery, PID reuse, malformed owner, bounded record,
  permission, and old-owner fencing tests
- Open-handle/temporary-file cleanup assertions
- `pnpm run typecheck`

### Exit criteria

State operations expose typed recoverable failures, and every ownership path
has exactly one verified finalizer without changing security semantics.

## Phase 4: Grant and raw-server resources

### Work

- Convert grant filesystem calls to Effects with typed path failures while
  retaining the current pure containment and route calculations.
- Preserve derivation of the default root before resolving the entry target.
- Convert authorized-file opening to scoped acquisition so every non-streamed
  branch closes the handle and streamed responses transfer ownership exactly
  once to the native stream.
- Wrap listener startup/close as a scoped resource. Preserve all Node HTTP
  limits, loopback binding, hostname generation, headers, status codes, and
  byte-stream behavior.
- Attach request work to the session-owned runtime/scope and verify aborted
  readers, shutdown, and handler defects cannot leak fibers or handles.
- Do not replace native `ServerResponse` streaming with an Effect body model.

### Validation

- All grant and HTTP tests
- Byte-for-byte entry/asset fixtures
- Traversal, encoding, symlink escape/swap, FIFO, large file, slow/aborted
  reader, authority, and unsupported-method tests
- Repeated start/close open-handle test
- `pnpm run validate:browser-origin`

### Exit criteria

The raw server is scope-owned and typed at its fallible boundaries, with no
observable HTTP or security-contract change.

## Phase 5: Supervisor registry and server

### Work

- Replace the Promise-tail mutation queue with one explicit Effect
  synchronization mechanism. Preserve FIFO-enough behavior for tested callers
  and never hold the mutation permit across unrelated static file reads.
- Give each pending session a child scope. Acquire the raw listener and verify
  readiness inside it; commit the ready summary and identity key atomically
  only after success.
- Close the child scope on failed readiness, targeted stop, and shutdown.
- Make session-limit reuse checks atomic so an existing matching session can
  still be reused at the limit.
- Convert the control listener to a scoped resource and decode requests with
  Phase 2 schemas. Preserve private socket permissions and exact authorization.
- Replace idle timers with a supervised fiber/TestClock policy where this does
  not weaken Node connection deadlines.
- Implement one idempotent shutdown Effect: reject new mutations, cancel idle
  work, close sessions, close control with the existing grace/force behavior,
  then release ownership.
- Define behavior for finalizer failure explicitly and test it; never report a
  fully stopped supervisor while an owned listener remains live.

### Validation

- Registry reuse, limit, readiness failure, concurrent create/stop, and
  shutdown ordering tests
- Control authorization, malformed body/query, maximum body, socket mode, and
  state-directory overlap tests
- TestClock idle-shutdown tests with no wall-clock sleeps
- Real Unix-socket startup/shutdown and transient-health integration tests
- No open handles after test completion

### Exit criteria

Supervisor resources form the target ownership tree, and every session/control
lifecycle invariant passes under both deterministic and real OS tests.

## Phase 6: Supervisor client

### Work

- Convert control requests to cancellable Effects with typed timeout,
  transport, HTTP-status, body-size, JSON, and schema-decode failures.
- Replace manual health/start/shutdown loops with named schedules that preserve
  the exact current attempt counts and deadlines.
- Keep probes distinct from ownership-changing operations; retry only safe
  health observations and documented idempotent commands.
- Convert supervisor discovery/start/recovery to Effects using the Phase 3
  scoped bootstrap lock. Preserve the rule that transient unavailability never
  replaces a live owner.
- Model detached process launch carefully: after successful handoff the
  supervisor must outlive the CLI scope. Scope launch setup/error listeners,
  not the intentionally detached process lifetime.
- Decode every server response with Phase 2 schemas and remove generic casts.
- Preserve version mismatch and `stop --all` cross-version behavior.

### Validation

- Focused schedule tests with TestClock
- Concurrent first start, stale socket, occupied socket, spawn failure,
  transient health, version mismatch, and shutdown confirmation tests
- Black-box child-process lifecycle tests
- Existing CLI-to-supervisor integration tests

### Exit criteria

The client contains no ad hoc delay loop or trusted unvalidated response, and
all ownership/recovery semantics remain intact.

## Phase 7: App services and executable entry points

### Work

- Convert `CommandService` to an Effect service with one production Layer and
  focused test Layers. Do not introduce thin services for pure result builders.
- Convert `runApp` orchestration to an Effect program. Keep command parsing
  synchronous and preserve usage failures as exit code 2 without starting the
  supervisor.
- Render expected tagged failures exhaustively to stable structured output;
  render unexpected defects as `runtime.internal` at the outer boundary and
  send diagnostic cause information only to stderr.
- Provide stdout/stderr/executable identity through the smallest testable I/O
  boundary. Preserve exactly one trailing newline at the executable boundary.
- Build one production Layer at `src/cli.ts` and one at
  `src/supervisor/supervisor-main.ts`.
- Use the selected Node runtime-main integration so SIGINT/SIGTERM interrupt
  the root program, run finalizers once, and set the correct exit code. Avoid
  `process.exit` before scoped cleanup completes.
- Delete obsolete Promise service interfaces, error translators, and signal
  cleanup paths after cutover.

### Validation

- All command/app/output contract tests
- Stdout/stderr separation and exact exit-code tests
- Signal-driven supervisor cleanup integration tests
- `pnpm run build`
- `pnpm run test:e2e`

### Exit criteria

Both executables have one Effect runtime boundary, no production Promise facade
remains between application modules, and the public CLI is byte/logically
compatible where required.

## Phase 8: Test-suite migration

### Work

- Move all TypeScript tests from Node's test runner to Vitest and use the
  `test/**/*.vitest.ts` naming convention.
- Use `@effect/vitest` for Effect programs and scoped fixtures.
- Replace injectable callback options with test Layers where the dependency is
  a real service boundary; keep direct function injection for pure algorithms.
- Replace timing sleeps with TestClock for policy tests. Keep real clock only
  where exercising OS scheduling, detached processes, sockets, or streaming is
  the purpose of the test.
- Add finalizer assertions for success, expected failure, interruption, defect,
  and concurrent shutdown.
- Add tests proving that error unions are handled exhaustively and protocol
  schemas reject malformed values.
- Remove obsolete runner dependencies/scripts and ensure one command runs the
  complete TypeScript suite.

### Validation

- Repeat the TypeScript suite to detect state leakage/order dependence
- Run with randomized test order if supported
- `pnpm run typecheck`
- `pnpm run lint`
- `pnpm test`
- `pnpm run test:e2e`

### Exit criteria

The TypeScript suite uses one Effect-aware runner, lifecycle policy tests are
deterministic, and real OS integration coverage remains intact.

## Phase 9: Packaging, docs, and release gate

### Work

- Finalize the package form selected in Phase 0. Ensure the tarball contains
  both executable entry points, source maps/declarations as intended, required
  licenses, and no build-only files or undeclared runtime imports.
- Compare tarball size, installed size, file count, CLI cold start, supervisor
  readiness, and idle memory against the Phase 0 baseline. Investigate material
  regressions instead of dismissing them as developer cost.
- Update [`ARCHITECTURE.md`](../../ARCHITECTURE.md) with the Effect runtime,
  service graph, scoped ownership tree, error flow, test seams, and actual code
  map.
- Update [`docs/CLI.md`](../CLI.md) only if internal implementation wording is
  stale; do not change the public contract as part of this migration.
- Update [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md) and
  [`docs/SECURITY_VALIDATION.md`](../SECURITY_VALIDATION.md) with any changed
  cancellation, resource-exhaustion, dependency, or bundling assumptions.
- Mark ADR/plan phases complete, compress migration-only detail that is no
  longer useful, and restore [`PLAN.md`](../../PLAN.md) to one concise release
  next action.
- Run the required code-review workflow with the diet lens. Remove unused
  services, layers, adapters, schemas, wrappers, and compatibility paths.

### Validation

- `pnpm run check`
- `pnpm run validate:browser-use`
- `pnpm run validate:package:linux`
- `pnpm audit`
- `pnpm run validate:docs`
- `git diff --check`
- Re-run package install/reinstall/uninstall on macOS/current platform and
  Linux, including detached supervisor cleanup

### Exit criteria

All definition-of-done items are evidenced, no unresolved review finding can
affect correctness or release behavior, and the Effect-based artifact is ready
for an explicit publication request.

## Validation matrix

| Risk                    | Required evidence                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Public CLI drift        | Golden logical TOON/JSON values, help, ordering, errors, stdout/stderr, exits 0/1/2       |
| Typed failure gaps      | Exhaustive error rendering and defect-boundary tests                                      |
| Protocol trust          | Bidirectional schema conformance plus malformed/oversized input tests                     |
| Resource leaks          | Finalizer tests, repeated start/stop, aborted requests, no open handles                   |
| Cancellation races      | Interrupt during acquire/readiness/transfer/stop and verify ownership/registry invariants |
| Concurrency             | Concurrent startup, duplicate serve, limit reuse, simultaneous stop/shutdown              |
| Filesystem confinement  | Existing traversal, encoding, symlink, FIFO, swap, home/state overlap tests               |
| Raw fidelity            | Exact source bytes, MIME/cache semantics, live edits, native streaming                    |
| Detached lifecycle      | CLI exit survival, signals, crash recovery, idle shutdown, full `stop --all`              |
| Browser state isolation | Fresh `.localhost` origins and existing browser-origin suite                              |
| Distribution            | Clean pack/install/reinstall/uninstall, version agreement, size/startup evidence          |
| Beta upgrade safety     | Exact pins, source/API inspection, full validation on every Effect update                 |

## Decision log

Keep this table current; replace `Pending` when a gate is resolved.

| Decision                | Current choice                                                                                                                                    | Evidence                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Effect version          | Pin `4.0.0-beta.98` across `effect`, `@effect/vitest`, and `@effect/platform-node`                                                                | Registry tags and matching package peers                                       |
| Canonical source        | `Effect-TS/effect` tag `effect@4.0.0-beta.98`, commit `3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec`                                                  | Canonical tagged source inspection                                             |
| Effect CLI              | Do not adopt                                                                                                                                      | Public AXI contract and option ordering differ                                 |
| Effect HTTP data plane  | Do not adopt in this migration                                                                                                                    | Raw-byte/security invariants and native Node tests                             |
| Node platform package   | Use only stable `@effect/platform-node/NodeRuntime`; keep native leaf adapters                                                                    | Signal interruption and teardown support cost 2,408 bundled bytes in the spike |
| Production package form | Two tree-shaken ESM bundles plus declarations and external source maps without embedded sources; keep TOON and MIME runtime dependencies external | Node 22 spike, real detached-entry check, and package-size evidence            |
| TypeScript test runner  | Vitest plus `@effect/vitest`                                                                                                                      | Effect test-clock/scoped-test requirement                                      |
| E2E/browser runners     | Keep Node test runner and Playwright                                                                                                              | Existing black-box contracts                                                   |
| Language-service gate   | Pinned editor plugin plus explicit strict diagnostics; no compiler-patching lifecycle hook                                                        | Offline schema, clean consumer install, and beta.98/TypeScript 6 verification  |
| Telemetry exporter      | None                                                                                                                                              | Out of scope; stderr/stdout contract unchanged                                 |

## Current blockers

- None.

## Next action

Execute Phase 9: finalize the package and security/architecture documentation,
compare the release artifact with the Phase 0 baseline, remove migration-only
surface, and run every current-platform and Linux/external release gate.

## Progress log

### 2026-07-15 — Phase 8 complete

- Renamed all TypeScript tests to the `.vitest.ts` convention and moved Node
  unit/integration suites onto the existing Vitest configuration. `pnpm test`
  now invokes one runner for the complete suite; the obsolete `tsx` runner and
  Phase 1 smoke test are gone.
- Removed the Promise-shaped supervisor-client test class. Real socket/process
  integration tests execute Effects explicitly only at their test boundary,
  while policy and scope tests use `@effect/vitest` programs directly.
- Replaced the exported Promise supervisor start/close transition with typed
  Effect APIs. Native Promise orchestration remains private inside the server;
  production and test modules now share the same Effect surface.
- Added acquisition-time interruption coverage proving an uninterruptible
  startup finishes and immediately finalizes without orphaning the socket or
  ownership lock. Shutdown-defect coverage now also asserts the public closed
  signal fails after all owned state is released.
- The 122-test suite passes twice consecutively and again with files/tests
  shuffled under seed `7152026`; focused supervisor integration and strict
  Effect diagnostics also pass.
- Final `pnpm run check` passes with the unified suite, two E2E lifecycle tests,
  seven Playwright checks, docs, build, and package lifecycle validation.
- Next: perform the Phase 9 artifact comparison, documentation compression,
  final diet review, and complete release gate without publishing.

### 2026-07-15 — Phase 7 complete

- Replaced the Promise command-service interface and per-method `runPromise`
  adapters with one Effect service. The CLI defines its production Layer while
  app tests supply focused Layers directly.
- Converted `runApp` to an Effect program without changing strict synchronous
  parsing or structured result shapes. Expected operational errors remain on
  the typed channel; defects render only `runtime.internal` on stdout and send
  diagnostic detail only to stderr; interruption is preserved.
- Replaced both top-level-await/manual-signal entry points with the narrow
  `NodeRuntime.runMain` adapter. The CLI retains its exact exit codes and one
  executable-boundary newline without bundling the platform HTTP stack.
- Added an explicit supervisor-closed Effect and a scoped production runner.
  Idle and `/shutdown` completion now end the root program, while SIGINT and
  SIGTERM interrupt it and run the same idempotent cleanup finalizer before the
  Node runtime exits with code 130.
- Deterministic tests cover app interruption, idle completion, and root-scope
  cleanup. Black-box E2E tests cover logical CLI compatibility, exact stdout
  newline/stderr separation, complete stop-all exit, and both signal cleanup
  paths.
- Final `pnpm run check` passes with 105 TypeScript tests, 17 Effect tests, two
  E2E tests, seven Playwright checks, docs, build, and package lifecycle
  validation.
- Next: consolidate the remaining TypeScript tests on Vitest and delete the
  temporary Promise-facing test seams in Phase 8.

### 2026-07-15 — Phase 6 complete

- Replaced the Promise-based Unix-socket request with one cancellable
  `Effect.callback`. Timeout, transport, response-size, and JSON failures are
  typed internally; interruption destroys the native request/response and a
  late response is rejected before it can attach listeners.
- Replaced the three-attempt health loop with a named schedule: one initial
  probe plus two retries, spaced 100 ms after unavailable results only. Existing
  absence, stale-socket, protocol, version, and public error semantics remain
  unchanged.
- Added client response-bound/parsing coverage and an exact six-probe assertion
  across two stalled operations. Required responses now retain typed transport,
  HTTP-status, JSON, response-size, and schema-decode failures before mapping
  once to the existing public operational errors.
- Discovery, startup, stale recovery, and shutdown confirmation are Effect
  programs. Bootstrap ownership stays inside the complete operation scope;
  separate Clock-driven schedules preserve the 5 s startup/shutdown and 10 s
  ownership soft attempt-start deadlines without retrying mutations.
- Detached launch scopes setup listeners only. A private abort signal kills an
  interrupted pre-handoff child, terminal listeners consume late spawn/error,
  and a successful handoff removes listeners and unrefs the intentionally
  long-lived supervisor.
- Review fixed the late-response listener race and a late detached-spawn race,
  then confirmed the raw Unix-socket and process seams earn their complexity.
  Deterministic tests cover interruption, exact health spacing, all three soft
  deadlines, lock release, and late child terminal events.
- The focused 41-test supervisor/state suite passes. Final `pnpm run check`
  passes with 104 TypeScript tests, 16 Effect tests, E2E, seven Playwright
  checks, docs, build, and package lifecycle validation.
- Next: replace the service and executable Promise boundaries with one provided
  Effect runtime path in Phase 7.

### 2026-07-15 — Phase 5 complete

- Replaced the Promise-tail registry with Effect's FIFO single-permit
  semaphore. Reuse, capacity checks, listener acquisition, readiness, and map
  commit remain one atomic mutation; ordinary static requests never take the
  permit.
- Each pending session now forks a child scope from the registry scope.
  Listener start and cancellable readiness run inside it, failed creation closes
  it before any map commit, and targeted/all-session stop closes the owned
  scope. Session start injection now uses the same scoped Effect contract as
  production.
- The control listener and its cancellable request fibers now share a scope;
  body readers remove native listeners on every exit. A supervised Clock-driven
  idle fiber replaces the raw timer, with TestClock coverage for expiry and for
  request activity winning the queued-close race.
- Shutdown first prevents new registry work, interrupts pending readiness, then
  closes idle work, sessions, control work, and ownership. Normal and startup
  cleanup attempt every finalizer and surface single or aggregate failures.
  Tests cover readiness interruption, finalizer defects, real Unix sockets,
  bounded stalled-client shutdown, and private state cleanup.
- Review fixed the queued idle-close race, removed the control listener's
  startup-only error handler after acquisition, and prevented cleanup failure
  from skipping ownership release. The bounded recheck found no remaining
  correctness or diet issue.
- Strict diagnostics, lint, 40 focused supervisor/state tests, and
  `git diff --check` pass. The final `pnpm run check` gate passed with 103
  TypeScript tests, ten Effect tests, E2E, seven Playwright checks, docs, build,
  and package lifecycle validation.
- Next: convert supervisor-client transport, polling, discovery, and recovery
  to cancellable Effects and named schedules.

### 2026-07-15 — Phase 4 complete

- Converted disclosure-grant filesystem leaves to typed `PathError` Effects
  while preserving default-root derivation before entry resolution, canonical
  containment, symlink route identity, home fallback, and public error codes.
- Promise-based app and supervisor orchestrators use narrow temporary
  `runPromise` adapters; no second grant implementation remains. Grant review
  found no Bucket I, Bucket II, or diet issue.
- Made authorized descriptors request-scoped while retaining nonblocking open,
  post-open realpath, bigint device/inode fencing, and every HTTP outcome. A
  successful `GET` transfers ownership exactly once to the bounded native
  auto-closing stream; all other branches release through the request scope.
- Made the native listener and a tracked `FiberSet` one scoped resource. Stream
  completion keeps the request fiber alive, while abort, defect, or listener
  shutdown destroys the response and releases outstanding work. The
  Promise-based registry uses one explicit temporary scope adapter until Phase
  5 supplies child session scopes directly.
- Added repeated listener-scope and active-stream shutdown tests. Review fixed
  a stale startup-only server error listener; bounded recheck found no Bucket
  I, Bucket II, or diet issue. The full `pnpm run check` gate passed with 100
  TypeScript tests, eight Effect tests, E2E, seven Playwright checks, docs,
  build, and package lifecycle validation.

### 2026-07-15 — Phase 3 complete

- Converted private runtime-directory, bounded-record, stale-socket, and
  ownership-lock operations to typed Effects without weakening native
  `O_NOFOLLOW`, `O_NONBLOCK`, device/inode, permission, or rename fencing.
- Replaced ownership polling with `Schedule` and `Clock`, and made lock
  ownership a scoped resource. Owner publication and finalizer registration
  now share one uninterruptible claim, so interruption cannot strand a
  published lock; handoff transfers release authority to an explicit
  authoritative scope.
- Kept cleanup diagnostics generic and stderr-only, removed a redundant state
  initialization path, and retained temporary explicit scopes only at the
  Promise-based client/server orchestration seams that Phases 5 and 6 replace.
- Added deterministic Effect tests for timeout boundaries, malformed-owner
  grace, permissions, release after success/failure/interruption, and ownership
  transfer. Real-filesystem supervisor tests cover temporary-file cleanup and
  public timeout mapping. Review fixed atomic finalizer registration, entropy
  failure cleanup, and the outer observation-timeout mapping; no Bucket II or
  diet finding remains. The full `pnpm run check` gate passed with 100
  TypeScript tests, six Effect tests, E2E, seven Playwright checks, docs, build,
  and package lifecycle validation.

### 2026-07-15 — Phase 2 complete

- Added recovery-boundary tagged errors with literal public codes, retained
  internal causes, exhaustive safe CLI projection, and defect sanitization at
  the outer boundary. Usage errors and `runtime.internal` remain separate.
- Replaced the hand-maintained control interfaces with strict Effect schemas
  and derived types. Client and server now encode requests and decode every
  health, success, and error response without unchecked protocol casts.
- Protocol validation covers exact request shapes, transport-sized strings,
  generated identifiers and URLs, selected list fields, request/response grant
  correlation, and operation-specific stop bounds while retaining arbitrary
  idempotent stop selectors.
- Focused protocol, error, app, and supervisor tests passed (63 tests), as did
  typecheck with strict Effect diagnostics, lint, formatting, and
  `git diff --check`. The full `pnpm run check` gate also passed with 100
  TypeScript tests, the Effect smoke, E2E, seven Playwright checks, docs, build,
  and package lifecycle validation. Review fixed three valid-shaped response
  invariants and cause retention; no Bucket II or diet finding remains.
  Expected-versus-defect narrowing stays at the leaf-adapter conversions in
  Phases 3–6.

### 2026-07-15 — Phase 1 complete

- Added ADR 0007 and the narrow ADR 0005 amendment, with exact beta.98 direct
  pins and overrides for ranged transitive Effect packages.
- Added explicit language-service diagnostics without a package lifecycle
  hook, plus a Vitest smoke covering schema decode, a tagged error, scoped
  finalization, and `TestClock`.
- The build now emits linked external source maps, declarations, and exactly
  two flat executable bundles. Browser-origin validation now exercises the
  built CLI instead of undocumented emitted internals.
- `pnpm install --frozen-lockfile`, typecheck and Effect diagnostics, lint, the
  smoke test, build, current-platform package install/reinstall/uninstall, the
  six browser-origin tests, and `git diff --check` passed. Review applied the
  local schema, effective pnpm overrides, and linked-source-map fixes; no
  decision finding remains.

### 2026-07-15 — Phase 0 complete

- Verified the green macOS, Browser Use, and Node 22 Linux baselines and
  recorded package size and process-start measurements above.
- Registry tags had no stable Effect v4: `latest` was 3.22.0 and `beta` was
  4.0.0-beta.98. Matching beta.98 tags exist for core, Vitest, and Node.
- Inspected the installed beta.98 source and canonical tag. Relevant v4 API
  changes include `Effect.callback` replacing `Effect.async`, explicit
  `forkChild` / `forkScoped` / `forkDetach` operations instead of a generic
  `fork`, `Semaphore` as the synchronization module, schema decoders such as
  `decodeUnknownEffect`, and `TestClock` under `effect/testing`. No unstable
  module is needed by the selected foundation.
- A throwaway esbuild 0.28.1 spike typechecked and passed an
  `@effect/vitest` 4.0.0-beta.98 TestClock test, released a scoped Node server,
  retained TypeScript source-map locations, and ran both bundles on Node 22.
  The `NodeRuntime` entry was 188,712 bytes versus 186,304 bytes for a minimal
  core-only runner.
- Bundling the real pre-migration entries proved the detached
  `supervisor-main.js` path. Existing CommonJS `mime-types` cannot be folded
  naively into an ESM bundle; keeping `mime-types` and `@toon-format/toon`
  external preserved the current dependency boundary and passed a real
  serve/stop lifecycle. Compact Effect spike maps were about 200 KiB each
  without embedded source content versus about 3 MiB each with it.
