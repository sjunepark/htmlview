# Implementation plan

- Updated: 2026-07-17
- Release target: `0.1.0`
- Publication status: unpublished

## Goal

Deliver a browser-neutral CLI that turns an explicitly granted local HTML tree
into a byte-faithful loopback URL and, on request, provides a separate human
review surface whose comments reach one agent as durable structured feedback.

## Current state

Raw serving, the per-user supervisor, Effect execution/resource ownership, and
the existing release gate are implemented. Human annotation is a core
first-release feature. Its public contracts are accepted. The Effect CLI,
native output boundary, symmetric state/grant exclusion, foreground/private
diagnostic sinks, durable annotation delivery, and the trusted browser review
surface are implemented. Release hardening remains, so `0.1.0` is not ready to
publish. The annotation authorization, hostile-content, authenticated
probe-readiness, and explicit instrumentation-limitation matrices now pass;
packaging and the final release matrix remain.

Documentation now has explicit ownership and current-versus-target status; see
[`docs/README.md`](docs/README.md). There is no external blocker.
The organized surface, contract tests, link/fragment checks, and packaged-link
closure pass the complete current-platform `pnpm run check` gate.

| Slice                             | Status      | Detail                                                                |
| --------------------------------- | ----------- | --------------------------------------------------------------------- |
| Raw serving and supervisor        | Complete    | Fidelity, confinement, private control, lifecycle, packaging          |
| Effect execution model            | Complete    | Typed failures, schemas, cancellation, scopes, release measurements   |
| Annotation and CLI contracts      | Complete    | Product, CLI, architecture, threat model, ADRs 0008–0009              |
| Documentation organization        | Complete    | Canonical map, ADR index, contract cleanup, validation hardening      |
| Effect CLI and diagnostic logging | Complete    | Native CLI, private logs, measurements, and complete release evidence |
| Annotation runtime                | In progress | Phase 4 adversarial evidence complete; packaging/release gate remains |
| Publication                       | Pending     | Complete release matrix and explicit publish action                   |

## Release invariants

- Raw entry and asset bodies remain unmodified and no operation writes into a
  serving grant.
- The canonical root is the complete read-disclosure grant; it and htmlview
  private state are disjoint in both directions.
- Browser-facing listeners bind only to loopback and validate their exact fresh
  `.localhost` authority.
- Supervisor control remains on the user-private Unix-domain socket under one
  lifetime owner.
- Domain stdout is one TOON value or logically equivalent JSON; native Effect
  CLI text and stderr diagnostics stay separate.
- Review uses different shell/content origins and cannot add to or change the
  raw origin.
- Feedback is durable, one-way, cursor-delivered, and never transported through
  logs.

## Required slices

### 1. Effect CLI and diagnostic logging

Complete Phase 10 in
[`docs/plans/effect-v4-adoption.md`](docs/plans/effect-v4-adoption.md). It owns
the implementation checklist, baseline measurements, and validation matrix.
The slice replaces the custom parser/help/dispatcher, adds stderr-only
foreground logging and bounded private supervisor logs, and enforces symmetric
grant/private-state exclusion before the file sink is enabled.

### 2. Annotation MVP

Then execute [`docs/plans/annotation-mvp.md`](docs/plans/annotation-mvp.md).
Its phases add shared authorized reads, review lifecycle, durable feedback,
trusted-shell/instrumented-content browser surfaces, and final fidelity/security
hardening. Annotation is not complete when only the browser UI works; durable
agent delivery is part of the feature.

## Release gate

Before publication, pass:

- `pnpm run check`;
- `pnpm run validate:browser-use`;
- `pnpm run validate:package:linux`;
- `pnpm audit`;
- `pnpm run validate:docs`; and
- `git diff --check`.

Extend those gates with native Effect CLI/channel/logging checks first, then
annotation origin, persistence, feedback, raw-fidelity, adversarial, and
real-browser checks. Rerun package size, cold-command, readiness, and idle-memory
measurements after Phase 10.

## Later work

TOON readability optimization remains deferred. Retain the current hostile
structural-character hardening until supported decoders prove logical fidelity
and a size comparison justifies changing it.

## Next action

Complete packaging and the release-command matrix for annotation. Do not
publish automatically.
