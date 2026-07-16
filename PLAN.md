# Implementation Plan

## Goal

Deliver a small agent-facing CLI that turns a local HTML entry and explicitly
granted directory root into a byte-faithful, confined loopback HTTP URL, then
optionally gives a human a separate instrumented review URL whose annotations
return to the agent as structured feedback. Browser tools remain separate,
interchangeable dependencies chosen by the caller.

## Current state

The version-one raw-serving implementation and Effect v4 execution model are
complete. Human annotation is required for `0.1.0`, but its runtime is not yet
implemented, so the artifact is not ready for publication. Annotation Phase 0
is complete. Before annotation runtime Phase 1, the accepted Effect CLI and
logging contract must replace the current custom parser and diagnostic path.

- Browser-origin evidence established fresh random `.localhost` names bound to
  `127.0.0.1` for cookie, storage, cache, and service-worker isolation.
- ADRs 0001–0009 record the browser boundary, supervisor, AXI domain output,
  serving grant, toolchain, private control socket, Effect execution model,
  separate raw/review feedback architecture, and native Effect CLI/logging
  boundary.
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
- Builds validate unique staged output and publish immutable,
  content-addressed generations behind one atomically replaced `dist/cli.js`
  launcher. Concurrent builds retain runnable, generation-consistent artifacts
  without a publication lock. Deterministic publication tests cover failure
  between installation and activation, competing distinct generations, and
  tampered generation reuse.
- Committed examples exercise standalone, relative-asset, and explicit-root
  workflows through source-checkout scripts and the black-box E2E suite.
- The Effect migration comparison and final implementation details are in
  [`docs/plans/effect-v4-adoption.md`](docs/plans/effect-v4-adoption.md).
- The planned annotation direction, defaults, milestones, fidelity boundary,
  and validation gate are in
  [`docs/plans/annotation-mvp.md`](docs/plans/annotation-mvp.md).
- Annotation Phase 0 aligned the domain language, product, CLI, architecture,
  threat model, README, ADR 0008, and executable documentation contracts. Raw
  remains the fidelity target; review uses separate shell/content origins and
  a durable one-way feedback queue. Home summaries keep retained work
  discoverable, stopped reviews resume with fresh origins, and `0.1.0` limits
  anchors to elements while retaining freeform feedback.
- ADR 0009 accepts pinned Effect CLI as the sole command parser and dispatcher,
  preserves structured TOON/JSON for domain results, adopts native text
  help/version/usage behavior, and separates foreground stderr logs from
  bounded private supervisor logs. Its implementation slice is next.

## Completed milestones

| Milestone                              | Result                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Browser-origin gate                    | Two independent controllers and retained-state isolation validated      |
| Foundation and AXI domain contract     | Strict baseline, TOON/JSON values, conformance fixtures                 |
| Faithful static serving                | Raw bytes, MIME/cache semantics, grant and adversarial confinement      |
| Supervisor and sessions                | Private control, ownership fencing, readiness, recovery, cleanup        |
| Agent interoperability                 | Real CLI URLs consumed by Playwright and Browser Use                    |
| Security and release hardening         | Bounds, permissions, hostile values, macOS/Linux package lifecycle      |
| Effect v4 adoption                     | Typed errors, schemas, scopes, cancellation, deterministic policy tests |
| Effect CLI/logging contract            | ADR 0009, native CLI boundary, private diagnostic-log policy            |
| Raw package and documentation baseline | Exact artifact surface, licenses, metrics, architecture/security docs   |
| Annotation contracts                   | ADR 0008, public CLI/API, trust model, anchoring, durable cursor queue  |

## Required `0.1.0` milestones

First complete the
[Effect CLI and logging slice](docs/plans/effect-v4-adoption.md):

- replace the custom parser, manual help model, and dispatcher with the exact
  pinned Effect CLI API, without a compatibility parser;
- keep no-argument home output and expected operational results as ordinary
  domain values encoded as TOON or logical JSON;
- adopt native text help, version, completions, log-level selection, and usage
  errors, with syntax failures exiting `1`; and
- route foreground Effect logs only to stderr and detached supervisor logs to
  bounded, rotated, user-private JSONL outside every serving grant.

The migration must preserve the raw HTTP, private control, and filesystem
security contracts. It adds no public log-reading command, and logs must never
contain annotation comments, anchors, DOM/HTML excerpts, form values,
credentials, file contents, raw protocol payloads, or attacker-controlled
strings.
Before the supervisor log sink is enabled, make the state/grant exclusion
symmetric: reject either directory when its canonical tree contains the other,
including symlinked and inverse-nesting cases.

Human annotation is a core first-release feature. Implement the focused
[annotation MVP plan](docs/plans/annotation-mvp.md) without changing the raw
URL or writing to served files:

- add an explicit review command that creates separate instrumented review
  origins for an existing raw session;
- let humans attach bounded element-targeted and freeform feedback through a
  trusted review shell;
- persist drafts and sent feedback in htmlview's private state directory; and
- deliver feedback to agents through a structured foreground wait command,
  with retry-safe cursor semantics instead of server logs.

Its ADR and public product/CLI/architecture/threat-model contracts are complete.
The remaining milestone includes implementation, real-browser E2E, adversarial
review-origin tests, raw-fidelity regressions, and package/release validation.
Annotation is not complete when only the browser UI works; the agent wake-up
and durable delivery path are part of the feature.

## Release validation

The release gate is:

- `pnpm run check`;
- `pnpm run validate:browser-use`;
- `pnpm run validate:package:linux`;
- `pnpm audit`;
- `pnpm run validate:docs`; and
- `git diff --check`.

The existing raw-serving gate passes. Before publication, extend it first with
the Effect CLI native-output, stdout/log isolation, log-level, rotation,
permission, and sensitive-data exclusion checks. Then add the annotation
plan's CLI contracts, state and security tests, raw-fidelity regressions, and
real-browser human-feedback loop on macOS/current platform and Node 22 Linux.
Rerun the complete current-platform, Browser Use, package, dependency-audit,
documentation, and final implementation/diet review gates.

## Later work

TOON readability optimization is also deferred until after `0.1.0`. Revisit
the quoted structural-character hardening only with evidence that supported
decoders preserve hostile values and with size comparisons showing the default
format remains worthwhile; retain the current hardening until then.

## Next action

Implement Phase 10 of the Effect adoption plan. Characterize the existing
domain values and operational errors, then replace the custom CLI parser,
manual help model, and dispatcher with pinned Effect CLI. Install the
foreground stderr logger and bounded private supervisor logger, update the
black-box/package checks, and remeasure the artifact. Only then begin
annotation Phase 1 at the raw authorized-file seam. Do not publish
automatically.
