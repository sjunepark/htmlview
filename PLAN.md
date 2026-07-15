# Implementation Plan

## Goal

Deliver a small agent-facing CLI that turns a local HTML entry and explicitly
granted directory root into a byte-faithful, confined loopback HTTP URL.
Browser tools remain separate, interchangeable dependencies chosen by the
caller.

## Current state

The version-one raw-serving implementation and Effect v4 execution model are
complete. The `0.1.0` artifact has not been published.

- Browser-origin evidence established fresh random `.localhost` names bound to
  `127.0.0.1` for cookie, storage, cache, and service-worker isolation.
- ADRs 0001–0007 record the browser boundary, supervisor, AXI output, serving
  grant, toolchain, private control socket, and Effect execution model.
- The CLI preserves byte-faithful GET/HEAD behavior, exact Host checks,
  canonical root confinement, read-only source handling, TOON/JSON logical
  equivalence, and explicit lifecycle control.
- One user-private supervisor owns scoped session listeners, request work,
  files, timers, and the lifetime lock. Client transport and detached startup
  are cancellable and ownership-safe.
- TypeScript tests run once under Vitest/`@effect/vitest`; native process E2E,
  Playwright/browser-controller, and clean installed-package validations remain
  separate release evidence.
- The package is two minified standalone ESM executables with external source
  maps, exact consumer documentation, bundled-dependency notices, and only
  TOON/MIME runtime dependencies.
- The Effect migration comparison and final implementation details are in
  [`docs/plans/effect-v4-adoption.md`](docs/plans/effect-v4-adoption.md).

## Completed milestones

| Milestone                              | Result                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Browser-origin gate                    | Two independent controllers and retained-state isolation validated      |
| Foundation and AXI contract            | Strict commands, TOON/JSON, help/errors, conformance fixtures           |
| Faithful static serving                | Raw bytes, MIME/cache semantics, grant and adversarial confinement      |
| Supervisor and sessions                | Private control, ownership fencing, readiness, recovery, cleanup        |
| Agent interoperability                 | Real CLI URLs consumed by Playwright and Browser Use                    |
| Security and release hardening         | Bounds, permissions, hostile values, macOS/Linux package lifecycle      |
| Effect v4 adoption                     | Typed errors, schemas, scopes, cancellation, deterministic policy tests |
| Package and documentation finalization | Exact artifact surface, licenses, metrics, architecture/security docs   |

## Release validation

The release gate is:

- `pnpm run check`;
- `pnpm run validate:browser-use`;
- `pnpm run validate:package:linux`;
- `pnpm audit`;
- `pnpm run validate:docs`; and
- `git diff --check`.

Current-platform tests, E2E, seven Playwright checks, strict Effect
diagnostics, build validation, clean install/reinstall/uninstall, Node 22 Linux
lifecycle, and dependency audit pass. Browser Use and final review are the
remaining Phase 9 checks; Browser Use is waiting for Chrome remote-debugging
consent.

## Later work

Optional human annotation remains deferred until after the raw-serving release
is stable. Any future workflow must consume the existing raw URL, keep state
outside served projects, preserve an uninstrumented route, and receive a
separate fidelity and threat-model review. No annotation interface is part of
the current release.

## Next action

Finish the remaining Phase 9 release gates and present the artifact for an
explicit publication decision. Do not publish automatically.
