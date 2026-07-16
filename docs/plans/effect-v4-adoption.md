# Effect v4 Adoption Plan

- Status: In progress; execution-model phases 0–9 and the Phase 10 native CLI
  migration are complete; private diagnostic logging remains
- Updated: 2026-07-16
- Parent plan: [`PLAN.md`](../../PLAN.md)
- Decisions: [ADR 0007](../decisions/0007-adopt-effect-v4.md),
  [ADR 0009](../decisions/0009-adopt-effect-cli-and-logging.md)

## Objective and outcome

Adopt Effect v4 as htmlview's execution, resource-lifecycle, CLI, and logging
model before the first publication without changing the raw HTTP, security,
browser-neutrality, disclosure-grant, or domain-result contracts.

The completed execution-model baseline has these properties:

- pure parsing, containment, result assembly, and HTTP calculations remain
  ordinary TypeScript;
- fallible asynchronous work uses typed Effect error channels;
- supervisor ownership, listeners, files, timers, request work, and session
  children have explicit scoped lifetimes;
- long waits and native transports are cancellable;
- both sides of the private protocol use the same Effect schemas;
- the TOON/JSON renderer and native raw HTTP data plane remain authoritative;
  and
- the CLI and supervisor each have one signal-aware Node runtime boundary.

Phase 10 now replaces the temporary custom parser, manual help model, and
dispatcher with the exact pinned `effect/unstable/cli` surface and adopts
Effect logging. It deliberately changes the unpublished CLI meta-contract:
Effect CLI owns text help, version, completions, log-level selection, and usage
errors, while htmlview continues to own no-argument home output and structured
TOON/JSON domain results. It does not introduce Effect HTTP, browser
dependencies, a compatibility parser, telemetry, plugins, public binding, or
annotation runtime work.

## Required invariants

- The serving root remains the complete explicit read-disclosure grant.
- Serving grants and private state are canonically disjoint in both directions.
- Raw entry and asset bytes are never transformed or written.
- Content binds only to `127.0.0.1` and validates its exact random
  `.localhost` authority.
- Control remains on the private Unix socket under lifetime-lock ownership.
- Ready-before-output, idempotent serve/stop, the 32-session bound, idle
  shutdown, and versioned control behavior are unchanged.
- Domain stdout contains only one TOON/JSON result or expected operational
  error. Effect CLI may emit native text help/version to stdout and usage help
  to stdout with a diagnostic on stderr. Effect logs never use stdout.
- Detached supervisor logs stay bounded, rotated, user-private, and outside
  every serving grant. They are diagnostics, never annotation delivery.
- Browser installation and automation remain outside the package.

## Phase status

| Phase                                 | Status      | Result/target                                             |
| ------------------------------------- | ----------- | --------------------------------------------------------- |
| 0. Baseline and API verification      | Complete    | Green baseline, beta.98 source inspection, package choice |
| 1. Decision records and toolchain     | Complete    | Exact pins, diagnostics, bundle and test foundation       |
| 2. Errors and protocol schemas        | Complete    | Tagged failures and one validated wire contract           |
| 3. Runtime-state and lock lifecycle   | Complete    | Typed, interruption-safe private state ownership          |
| 4. Grant and raw-server resources     | Complete    | Scoped files/listeners with byte fidelity intact          |
| 5. Supervisor registry and server     | Complete    | Scoped sessions, control work, idle shutdown              |
| 6. Supervisor client                  | Complete    | Cancellable transport, schedules, launch handoff          |
| 7. App services and entry points      | Complete    | One Effect runtime path per executable                    |
| 8. Test-suite migration               | Complete    | One Effect-aware TypeScript runner                        |
| 9. Packaging, docs, and release gate  | Complete    | Execution-model release gate and artifact audit passed    |
| 10. Effect CLI and diagnostic logging | In progress | Native CLI complete; private log sink and hardening next  |

## Version and package decisions

| Decision              | Accepted choice                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Effect version        | Exact `4.0.0-beta.98` pins for core, Vitest, and Node platform                                   |
| Canonical source      | `Effect-TS/effect` tag `effect@4.0.0-beta.98`, commit `3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec` |
| Runtime integration   | Only `@effect/platform-node/NodeRuntime`; native Node leaf adapters remain                       |
| Production package    | Two minified ESM executables and linked external maps without embedded sources                   |
| Module/type surface   | None; this is a bin-only package, so internal declarations are not shipped                       |
| Runtime dependencies  | TOON and MIME stay external; Effect and audited transitive packages are bundled                  |
| Test runners          | Vitest/`@effect/vitest` for TypeScript, Node for E2E, Playwright for browsers                    |
| Language-service gate | Exact plugin pin and explicit strict diagnostics; no consumer lifecycle hook                     |
| CLI                   | Pinned `effect/unstable/cli` is the sole parser, help generator, and dispatcher                  |
| Logging               | Effect Logger to foreground stderr and bounded private supervisor JSONL                          |

The build rejects undeclared external imports and changes to the licensed
bundled dependency set. The tarball contains exactly two executable entries,
their maps, consumer documentation, project and third-party licenses, and
package metadata. It excludes plans, validation programs, sources,
declarations, and other build-only files.

## Baseline and release comparison

Phase 0 recorded commit `99f950b24a310683926d1dd5a1f9e84288f7f025`
on macOS 26.5.1 arm64, Node 24.15.0, and pnpm 11.13.0. The historical tarball
included the then-dirty plan documents; a clean checkout therefore reproduces
slightly smaller package numbers. The table uses the recorded baseline where
available and matched installed-artifact samples for the added readiness/RSS
comparison.

| Measure                                  | Phase 0      | Phase 9 artifact | Change   |
| ---------------------------------------- | ------------ | ---------------- | -------- |
| Tarball                                  | 77,330 bytes | 819,664 bytes    | 10.60x   |
| Packed files                             | 61           | 23               | 38 fewer |
| Installed size incl. dependencies        | 840 KiB      | 3,092 KiB        | 3.68x    |
| Installed files                          | 78           | 40               | 38 fewer |
| Historical structured version, 11 spawns | 65.36 ms     | 74.29 ms         | +13.7%   |
| Empty query median, 7 fresh daemons      | 84.23 ms     | 84.234 ms        | <+0.01%  |
| Fresh `serve` readiness median, 7        | 204.37 ms    | 218.85 ms        | +7.08%   |
| Empty-supervisor RSS median, 7           | 65,632 KiB   | 75,184 KiB       | +14.55%  |

These are local process samples, not benchmarks. The larger tarball is mainly
two standalone copies of the bundled runtime and their debuggable external
maps. The selected form avoids a shared-chunk discovery contract and installs
only two small external runtime dependency trees. Minification, removal of
unused declarations, and an explicit documentation allowlist reduced the
pre-audit Effect artifact from 938,138 bytes/39 files/4,320 KiB/56 installed
files to the figures above. Cold command and readiness impact is bounded; the
measured empty-daemon memory increase is retained as a release reference.
These figures predate Phase 10. Remeasure with native `--version`, no-argument
home output, fresh `serve`, and an idle supervisor after the CLI/logging slice;
`--version --json` is not a target contract.

## Phase 10: Effect CLI and diagnostic logging

Current progress:

- Complete: the custom parser/manual help model is removed; one pinned Effect
  command tree owns grammar, native help/version/completions/log-level, syntax
  rejection, and dispatch.
- Complete: domain TOON/JSON behavior, native channel separation, exit `1`,
  sanitized defect projection, foreground log-level routing, package smoke,
  build concurrency, and black-box native CLI tests pass.
- Complete: the build license gate and notices include the additional
  INI/TOML/YAML parsers brought into the standalone CLI by
  `NodeServices.layer`.
- Next: enforce symmetric grant/private-state exclusion, finish the closed
  diagnostic seam migration, and add bounded rotated supervisor JSONL with its
  permissions, rotation, restart, structural, and canary tests.

1. Characterize current domain values, idempotency, supervisor interactions,
   and operational error projections independently from the custom parser.
2. Define the command tree once with pinned Effect CLI. Remove the custom
   parser, manual help models, and hand-written dispatcher; do not retain a
   compatibility wrapper. Keep `--json` as htmlview's global domain-output
   option and `--fields` scoped to the no-argument home command. Follow the
   [Effect Solutions CLI guide](https://www.effect.solutions/cli) as
   non-normative composition guidance. The
   [exact pinned source](https://github.com/Effect-TS/effect/tree/3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec/packages/effect/src/unstable/cli)
   is authoritative for behavior.
3. Accept Effect CLI's native `--help`/`-h`, `--version`/`-v`,
   `--completions`, and `--log-level` behavior. Native help/version are text;
   syntax diagnostics are native text and exit `1`. `--json` does not rewrite
   native meta output.
4. Keep successful domain results and expected operational failures as one
   ordinary JSON-compatible value encoded to TOON by default or logical JSON
   with `--json`. Sanitize unexpected defects into a stable public runtime
   failure while logging only allowlisted diagnostic context. Terminate both
   executable roots through explicit cause projection so `NodeRuntime` never
   prints a second raw cause.
5. Configure foreground Effect logs exclusively on stderr. Configure the
   detached supervisor with bounded rotation to user-private JSONL beneath the
   existing runtime-state directory; use directory mode `0700` and file mode
   `0600`, publish no browser route or public log command, and define exact
   size/file-count bounds as implementation constants. For the pinned beta,
   install the explicit `Logger.LogToStderr` routing reference/layer and prove
   the captured channel; do not assume a pretty-logger option changes the sink.
   Keep ordinary foreground success and caller-error paths quiet at info; make
   debug/trace opt-in. Give the supervisor a fixed info threshold rather than
   persisting or inheriting a launching command's transient level.
   Before writing logs, tighten root validation to reject canonical
   runtime-state/grant overlap in either direction and add inverse-nesting and
   symlink tests.
6. Put application logging behind a closed diagnostic-event type whose only
   fields are fixed operation/span name, stable error code, opaque internal
   identifier, duration, and bounded counts; the sink adds timestamp and level.
   The logger validates and serializes only those keys; do not expose arbitrary
   messages, error objects, or annotation maps.
   Add a lint or structural test that rejects direct application `Effect.log*`
   calls outside this seam. Never log comments, prompt text, anchors, selectors,
   DOM/HTML excerpts, form values, headers, cookies, credentials, full paths,
   file contents, raw protocol payloads, dependency error text, or other
   attacker-controlled strings.
7. Update native-process, package-smoke, documentation, and distribution tests;
   in particular, replace structured-version assumptions in
   `validation/package/install-smoke.mjs`,
   `validation/package/linux-smoke.sh`, and
   `validation/build/concurrency.test.mjs`, and replace the custom parser
   expectations in `test/command.vitest.ts` and `test/app.vitest.ts`.
   Regenerate help/completion fixtures only if they prove stable enough to be
   useful. Remeasure package size, cold commands, readiness, and idle memory.

## Validation matrix

| Risk                    | Evidence                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| Domain-output drift     | TOON/JSON logical values, schemas, contextual commands, channels            |
| Native CLI behavior     | Help/version/completions/log-level, strict syntax, text channels, exit `1`  |
| Log isolation           | No log bytes on stdout; `--log-level none`; stderr-only foreground events   |
| Private log safety      | `0700`/`0600`, rotation bounds, restart cleanup, sensitive-field exclusion  |
| Typed failure gaps      | Exhaustive public projection and defect-boundary tests                      |
| Protocol trust          | Bidirectional schemas plus malformed, oversized, and uncallable-ID cases    |
| Resource leaks          | Finalizer defects, repeat start/stop, aborted requests, installed cleanup   |
| Cancellation races      | Interrupt acquire, readiness, transfer, transport, body read, and shutdown  |
| Concurrency             | Startup, duplicate serve, limits, simultaneous stop/shutdown                |
| Filesystem confinement  | Traversal, encoding, symlink, FIFO, swap, home/state overlap                |
| Raw fidelity            | Exact bytes, MIME/cache behavior, live edits, native streaming              |
| Detached lifecycle      | CLI survival, signals, crash recovery, idle shutdown, complete stop-all     |
| Browser state isolation | Fresh `.localhost` origins and the browser-origin suite                     |
| Distribution            | Exact/reproducible pack, install/reinstall/uninstall, size/startup evidence |
| Beta upgrade safety     | Exact pins, source/API inspection, audit and full validation on each update |

The Phase 9 current-platform repository gate passed its Vitest and black-box
E2E suites, seven Playwright checks, strict Effect diagnostics, documentation
validation, build validation, and clean package lifecycle. The
Node 22 Linux lifecycle check passes with complete PID/socket/lock cleanup, and
`pnpm audit` reports no known vulnerabilities. Browser Use 0.1.5 consumes the
installed CLI URL and passes the complete interoperability fixture through the
user-approved Chrome DevTools endpoint. Phase 10 must rerun this evidence after
the CLI grammar and logger sinks change.

## Next action

Finish the Phase 10 logging/security remainder above, then rerun the complete
gate and measurements. Preserve the completed execution model, native CLI, raw
serving, private control, and filesystem-security baseline. After the full gate
passes, begin Phase 1 of the [annotation MVP](annotation-mvp.md). Do not publish
automatically.
