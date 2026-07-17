# Implementation plan

- Updated: 2026-07-17
- Release target: `0.1.0`
- Publication status: unpublished

## Goal

Deliver a browser-neutral CLI that turns an explicitly granted local HTML tree
into a byte-faithful loopback URL and, on request, provides a separate human
review surface whose comments reach one agent as durable structured feedback.
When that agent edits the selected entry HTML, the live review refreshes its
own instrumented representation automatically so the human can continue the
feedback loop without a manual reload.

## Current state

Raw serving, the per-user supervisor, Effect execution/resource ownership, and
the existing release gate are implemented. Human annotation is a core
first-release feature. Its public contracts are accepted. The Effect CLI,
native output boundary, symmetric state/grant exclusion, foreground/private
diagnostic sinks, durable annotation delivery, and the trusted browser review
surface are implemented. Automatic selected-entry refresh is now the next
annotation slice; packaging and final release hardening follow it, so `0.1.0`
is not ready to publish. The existing annotation authorization,
hostile-content, authenticated probe-readiness, and explicit
instrumentation-limitation matrices pass and must remain intact through the
refresh work. Review navigation now requires a shell-minted one-use capability,
target messages are bound to the active probe lease/revision, and stop/delete
persistence barriers prevent ready-but-closed review records. Supervisor
protocol mismatches are rejected explicitly without compatibility fallbacks.

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
| Annotation runtime                | In progress | Automatic selected-entry refresh is next; packaging follows           |
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
- Entry-change observation belongs to the review lifecycle. It may refresh the
  instrumented review iframe but never injects a client into the raw page or
  claims to refresh arbitrary raw consumers.
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
trusted-shell/instrumented-content browser surfaces, automatic selected-entry
refresh, and final fidelity/security hardening. Annotation is not complete when
only the browser UI works; durable agent delivery and the edit-review loop are
both part of the feature.

## Release gate

Before publication, pass:

- `pnpm run check`;
- `pnpm run validate:browser-use`;
- `pnpm run validate:package:linux`;
- `pnpm audit`;
- `pnpm run validate:docs`; and
- `git diff --check`.

Extend those gates with native Effect CLI/channel/logging checks first, then
annotation origin, persistence, feedback, automatic refresh, raw-fidelity,
adversarial, and real-browser checks. Rerun package size, cold-command,
readiness, and idle-memory measurements after Phase 10 and account for the
bounded refresh observer before release.

## Later work

TOON readability optimization remains deferred. Retain the current hostile
structural-character hardening until supported decoders prove logical fidelity
and a size comparison justifies changing it.

## Next action

Implement Phase 5, automatic selected-entry refresh, in
[`docs/plans/annotation-mvp.md`](docs/plans/annotation-mvp.md). A ready review
must observe confirmed byte changes to its original entry, coalesce writes,
notify its trusted shell, and reload only the instrumented iframe while leaving
the raw route and already-loaded raw consumers untouched. Preserve drafts with
their capture revisions; keep the last rendered review non-annotatable while
the fixed entry pathname is unavailable. Close every observer/notification
resource on stop, End, deletion, or failed acquisition. Then finish packaging
and the release-command matrix. Do not publish automatically.
