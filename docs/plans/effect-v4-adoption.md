# Effect v4 Adoption Plan

- Status: Complete; artifact ready for an explicit publication request
- Updated: 2026-07-16
- Parent plan: [`PLAN.md`](../../PLAN.md)
- Decision: [ADR 0007](../decisions/0007-adopt-effect-v4.md)

## Objective and outcome

Adopt Effect v4 as htmlview's execution and resource-lifecycle model before
the first publication without changing the accepted CLI, HTTP, security,
browser-neutrality, or disclosure-grant contracts.

The implemented production path now has these properties:

- pure parsing, containment, result assembly, and HTTP calculations remain
  ordinary TypeScript;
- fallible asynchronous work uses typed Effect error channels;
- supervisor ownership, listeners, files, timers, request work, and session
  children have explicit scoped lifetimes;
- long waits and native transports are cancellable;
- both sides of the private protocol use the same Effect schemas;
- the custom command parser, TOON/JSON renderer, and native raw HTTP data plane
  remain authoritative; and
- the CLI and supervisor each have one signal-aware Node runtime boundary.

No Effect CLI, Effect HTTP data plane, browser dependency, compatibility
implementation, new flag, new output field, telemetry, plugin, public bind, or
annotation work was introduced.

## Preserved invariants

- The serving root remains the complete explicit read-disclosure grant.
- Raw entry and asset bytes are never transformed or written.
- Content binds only to `127.0.0.1` and validates its exact random
  `.localhost` authority.
- Control remains on the private Unix socket under lifetime-lock ownership.
- Ready-before-output, idempotent serve/stop, the 32-session bound, idle
  shutdown, and versioned control behavior are unchanged.
- Stdout contains only structured results or errors; diagnostics stay on
  stderr.
- Browser installation and automation remain outside the package.

## Phase status

| Phase                                | Status   | Result                                                    |
| ------------------------------------ | -------- | --------------------------------------------------------- |
| 0. Baseline and API verification     | Complete | Green baseline, beta.98 source inspection, package choice |
| 1. Decision records and toolchain    | Complete | Exact pins, diagnostics, bundle and test foundation       |
| 2. Errors and protocol schemas       | Complete | Tagged failures and one validated wire contract           |
| 3. Runtime-state and lock lifecycle  | Complete | Typed, interruption-safe private state ownership          |
| 4. Grant and raw-server resources    | Complete | Scoped files/listeners with byte fidelity intact          |
| 5. Supervisor registry and server    | Complete | Scoped sessions, control work, idle shutdown              |
| 6. Supervisor client                 | Complete | Cancellable transport, schedules, launch handoff          |
| 7. App services and entry points     | Complete | One Effect runtime path per executable                    |
| 8. Test-suite migration              | Complete | One Effect-aware TypeScript runner                        |
| 9. Packaging, docs, and release gate | Complete | Full release gate and artifact audit passed               |

## Version and package decisions

| Decision              | Implemented choice                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Effect version        | Exact `4.0.0-beta.98` pins for core, Vitest, and Node platform                                   |
| Canonical source      | `Effect-TS/effect` tag `effect@4.0.0-beta.98`, commit `3e4abbcb0d0e9a5e82b6b88c7ef7ab69900105ec` |
| Runtime integration   | Only `@effect/platform-node/NodeRuntime`; native Node leaf adapters remain                       |
| Production package    | Two minified ESM executables and linked external maps without embedded sources                   |
| Module/type surface   | None; this is a bin-only package, so internal declarations are not shipped                       |
| Runtime dependencies  | TOON and MIME stay external; Effect and audited transitive packages are bundled                  |
| Test runners          | Vitest/`@effect/vitest` for TypeScript, Node for E2E, Playwright for browsers                    |
| Language-service gate | Exact plugin pin and explicit strict diagnostics; no consumer lifecycle hook                     |

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

| Measure                              | Phase 0      | Effect artifact | Change   |
| ------------------------------------ | ------------ | --------------- | -------- |
| Tarball                              | 77,330 bytes | 819,664 bytes   | 10.60x   |
| Packed files                         | 61           | 23              | 38 fewer |
| Installed size incl. dependencies    | 840 KiB      | 3,092 KiB       | 3.68x    |
| Installed files                      | 78           | 40              | 38 fewer |
| `--version --json` median, 11 spawns | 65.36 ms     | 74.29 ms        | +13.7%   |
| Empty query median, 7 fresh daemons  | 84.23 ms     | 84.234 ms       | <+0.01%  |
| Fresh `serve` readiness median, 7    | 204.37 ms    | 218.85 ms       | +7.08%   |
| Empty-supervisor RSS median, 7       | 65,632 KiB   | 75,184 KiB      | +14.55%  |

These are local process samples, not benchmarks. The larger tarball is mainly
two standalone copies of the bundled runtime and their debuggable external
maps. The selected form avoids a shared-chunk discovery contract and installs
only two small external runtime dependency trees. Minification, removal of
unused declarations, and an explicit documentation allowlist reduced the
pre-audit Effect artifact from 938,138 bytes/39 files/4,320 KiB/56 installed
files to the figures above. Cold command and readiness impact is bounded; the
measured empty-daemon memory increase is retained as a release reference.

## Validation matrix

| Risk                    | Evidence                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| Public CLI drift        | TOON/JSON logical values, help, ordering, errors, channels, exit codes      |
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

The complete current-platform repository gate passes with 123 Vitest tests,
two black-box E2E tests, seven Playwright checks, strict Effect diagnostics,
documentation validation, build validation, and clean package lifecycle. The
Node 22 Linux lifecycle check passes with complete PID/socket/lock cleanup, and
`pnpm audit` reports no known vulnerabilities. Browser Use 0.1.5 consumes the
installed CLI URL and passes the complete interoperability fixture through the
user-approved Chrome DevTools endpoint.

## Current blockers

- None.

## Next action

Present the validated `0.1.0` artifact for an explicit publication decision.
Do not publish automatically, and keep optional annotation work deferred.
