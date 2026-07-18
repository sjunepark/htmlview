# Implementation plan

- Updated: 2026-07-18
- Release target: `0.1.0`
- Publication status: unpublished

## Goal

Deliver a browser-neutral CLI that turns an explicitly granted local HTML tree
into a byte-faithful loopback URL and, on request, provides a separate human
review surface whose comments reach one agent as durable structured feedback.
When that agent edits the selected entry HTML or a bounded linked resource
loaded by the review, the live review refreshes its own instrumented
representation automatically so the human can continue the feedback loop
without a manual reload.

## Current state

Raw serving, the per-user supervisor, Effect execution/resource ownership, and
the existing release gate are implemented. Human annotation is a core
first-release feature. Its public contracts are accepted. The Effect CLI,
native output boundary, symmetric state/grant exclusion, foreground/private
diagnostic sinks, durable annotation delivery, and the trusted browser review
surface are implemented. Bounded entry and served-resource refresh and the
source-checkout `example:review` workflow, installed-package review guidance,
and the macOS and Node 22 Linux installed review/observer lifecycle checks are
now implemented. A portable Agent Skill for external CLI users is implemented
and included in the version-matched npm artifact. The complete release-command
matrix, refreshed resource measurements, and final implementation/diet review
pass against the current bounded served-resource observer. The `0.1.0`
candidate is release-ready and remains unpublished. The annotation
authorization, hostile-content, authenticated probe-readiness, and explicit
instrumentation-limitation matrices pass and must remain intact through the
refresh work. Review navigation now requires a shell-minted one-use capability,
target messages are bound to the active probe lease/revision, and stop/delete
persistence barriers prevent ready-but-closed review records. Supervisor
protocol mismatches are rejected explicitly without compatibility fallbacks.
Observer-driven iframe navigation is bound to its confirmed expected revision,
automatic replacements are promoted only after authenticated probe readiness,
and shell polling now has explicit active, hidden-page paused, and terminal
phases rather than an unbounded reconnect path. Source-checkout feedback stays
behind the example wrapper without exposing the private state-directory
override. A deterministic browser-to-waiting-CLI-to-refresh test now closes the
complete feedback-loop evidence in the normal gate. A separate source-checkout
`validate:codex` evaluation uses a freshly installed package and ephemeral
Codex session to prove that a real coding agent can consume, apply, acknowledge,
and visibly refresh one controlled feedback batch without coupling validation
to the developer's active session.

Documentation now has explicit ownership and current-versus-target status; see
[`docs/README.md`](docs/README.md). There is no external blocker.
The organized surface, contract tests, link/fragment checks, and packaged-link
closure pass the complete current-platform `pnpm run check` gate.

| Slice                             | Status   | Detail                                                                   |
| --------------------------------- | -------- | ------------------------------------------------------------------------ |
| Raw serving and supervisor        | Complete | Fidelity, confinement, private control, lifecycle, packaging             |
| Effect execution model            | Complete | Typed failures, schemas, cancellation, scopes, release measurements      |
| Annotation and CLI contracts      | Complete | Product, CLI, architecture, threat model, ADRs 0008–0009                 |
| Documentation organization        | Complete | Canonical map, ADR index, contract cleanup, validation hardening         |
| Effect CLI and diagnostic logging | Complete | Native CLI, private logs, measurements, and complete release evidence    |
| Annotation runtime                | Complete | Durable feedback, trusted review UI, and bounded automatic refresh       |
| Packaging and release hardening   | Complete | Installed checks, Agent Skill, measurements, release matrix, review pass |
| Publication                       | Pending  | Requires a later explicit production-promotion action                    |

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
- Entry and tracked-resource observation belongs to the review lifecycle. It
  may refresh the instrumented review iframe but never enumerates the grant,
  injects a client into the raw page, or claims to refresh raw consumers.
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
trusted-shell/instrumented-content browser surfaces, bounded automatic review
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

Keep the release-ready `0.1.0` candidate unpublished. Production promotion is
outside this plan and requires a later explicit action; never publish
automatically.

## Progress log

### 2026-07-18

- Addressed PR #7 review findings across the Codex acceptance harness and Agent
  Skill guidance. Cleanup now fails before allocation on unsupported platforms,
  preserves the original Host on loopback raw checks, retains every primary and
  cleanup failure, and removes private state only after a nonce- and
  process-identity-bound supervisor exit. Linux process-group checks ignore
  terminated zombies without weakening live-descendant detection.
- Made process escalation tests readiness-driven, documented the exact supported
  acceptance platforms and project/user skill scopes, and included an actionable
  unpublished-candidate install path in the copied skill. The bounded
  implementation/design/diet review is clean; `pnpm run check`, the authenticated
  `pnpm run validate:codex`, Linux packaged-artifact validation, documentation
  validation, and Node 22/24 Linux process tests—including throttled runs—pass.
- Added a portable, manually invoked `htmlview` Agent Skill to the npm artifact.
  It keeps live CLI help authoritative, chooses the narrowest serving grant,
  preserves the raw/review fidelity boundary, and discloses the durable
  feedback loop only when that branch is needed. OpenAI metadata disables
  implicit invocation, matching the external skill-catalog convention.
- Added skill contract and package-contents coverage plus version-matched
  installation guidance. Official skill validation, local and packaged skill
  discovery, isolated raw/review forward tests, the complete current-platform
  `pnpm run check` gate, and Node 22 Linux package validation pass. The bounded
  implementation/design/diet review applied only narrow lifecycle and removal
  clarifications and left no pending decision.
- Added release-gated browser coverage for a waiting CLI consumer receiving a
  sent element comment, applying the edit, refreshing the live review and raw
  bytes, and acknowledging the durable cursor.
- Added the opt-in `pnpm run validate:codex` acceptance evaluation. It packs and
  installs htmlview in an isolated temporary fixture, submits controlled browser
  feedback, runs a fresh ephemeral `codex exec`, and checks the exact edit,
  acknowledgement, refresh, raw response, and cleanup. Model credentials are
  excluded from every setup and htmlview subprocess; sandboxed commands can
  reach only the temporary private control socket through an exact network-proxy
  allowlist. A least-privilege permission profile now limits reads to the fixture,
  installed package, runtime tools, and private state, limits writes to the
  served fixture subtree and isolated private state, and proves the filesystem
  and socket boundary with pre-agent canaries. Agent timeout and output limits
  terminate the complete process group so descendants cannot retain cleanup
  pipes. The hardened live acceptance evaluation passes with the installed
  Codex CLI.
- Addressed PR review findings in the served-resource refresh path: confirmed
  entry revisions now reset the tracked-resource generation, candidate assets
  are force-read as an accumulated set before publication, review assets bypass
  stale validators, and incomplete or disconnected responses release
  observation capacity.
- Added regression coverage for generation reset, unchanged-metadata races,
  short response bodies, retry-exhaustion recovery, and review-only cache
  behavior. The focused suites, complete `pnpm run check` gate, and Node 22
  Linux installed-package validation pass.
- Revalidated commit `292e727c1428e4361605d2276c4cd732b5e2cab4` on macOS
  26.5.1 arm64 with Node 24.15.0 and pnpm 11.13.0. The ready-review RSS sample
  registered one linked stylesheet and confirmed an observed byte change before
  sampling the bounded served-resource observer.
- Refreshed package, cold-command, readiness, and RSS measurements against the
  Phase 10 baseline. One ready review with an active linked-resource observer
  adds a median 1,392 KiB over the current empty supervisor.
- The pre-PR implementation and diet review found no material defect,
  validation gap, or unearned abstraction. The completed-body observation
  handshake, separate bounded entry/asset state, opaque aggregate revision,
  navigation epoch, and watcher-plus-polling fallback remain justified.
- Final release matrix: `pnpm run check`, `pnpm run validate:browser-use`,
  `pnpm run validate:package:linux`, `pnpm audit`, `pnpm run validate:docs`, and
  `git diff --check` pass. A registry read confirms `0.1.0` remains unpublished.

### 2026-07-17

- Completed automatic entry and served-resource refresh with scoped
  authorization, deterministic byte revisions, unrelated-file exclusion,
  polling fallback, staged follow-up navigation, dirty-feedback deferral, and
  bounded shell polling.
- Validation after that implementation: `pnpm run check` passes the full
  Vitest and browser-origin suites, black-box CLI/example workflows,
  interoperability, build validation, and package install/reinstall/uninstall
  smoke. Release-only external/Linux/audit checks and refreshed resource
  measurements remain pending.
- Added and documented `pnpm example:review`; its result includes the review
  URL/ID and associated raw-session URL/ID.
- Bound automatic navigation to the observer-confirmed revision, added bounded
  polling termination across local/peer closure, and added the state-isolated
  `example:feedback` pass-through.
- Kept the authenticated rendered iframe visible across failed refresh races,
  restored same-revision retry/limitation state, and paused polling for ordinary
  hidden documents as well as page-history transitions.
- Added one package-excluded installed-artifact workflow shared by the
  current-platform and Node 22 Linux checks. It proves raw fidelity, review
  shell startup, feedback-state reads, observer-detected entry revisions, and
  complete supervisor cleanup through the installed executable.
- Added installed review guidance and validated the reproducible
  install/review/observer/reinstall/uninstall lifecycle on macOS and Node 22
  Bookworm.
- Resolved a release-only flaky shutdown test by pausing its sparse client
  before flowing, resuming only after scope closure, and requiring an incomplete
  destroyed response. The focused contract passes 100 macOS runs and 50 clean
  Node 22 Bookworm runs.
