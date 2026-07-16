# Annotation MVP plan

- Status: Phase 1 complete; Phase 2 next
- Updated: 2026-07-17
- Parent: [`PLAN.md`](../../PLAN.md)
- Decision: [ADR 0008](../decisions/0008-separate-raw-serving-from-instrumented-review.md)
- CLI boundary: [ADR 0009](../decisions/0009-adopt-effect-cli-and-logging.md)

## Objective

Ship human annotation in `0.1.0` without changing the raw URL or writing into a
served project. A human selects an element or leaves freeform feedback in a
separate review surface; one agent receives durable structured events through a
foreground CLI operation.

The design borrows the useful separation in Lavish AXI—detached serving,
browser-side review, and a foreground structured wait—but not its public bind,
browser launch, raw-path transformation, destructive reads, or log delivery.

## Contract ownership

| Concern                                  | Authority                                                  |
| ---------------------------------------- | ---------------------------------------------------------- |
| User jobs, scope, non-goals              | [`docs/PRODUCT.md`](../PRODUCT.md)                         |
| Commands, schemas, cursor/error behavior | [`docs/CLI.md`](../CLI.md)                                 |
| Component boundaries and flows           | [`ARCHITECTURE.md`](../../ARCHITECTURE.md)                 |
| Trust boundaries and controls            | [`docs/THREAT_MODEL.md`](../THREAT_MODEL.md)               |
| Required evidence                        | [`docs/SECURITY_VALIDATION.md`](../SECURITY_VALIDATION.md) |
| Domain terms                             | [`CONTEXT.md`](../../CONTEXT.md)                           |

This plan owns implementation order and completion state, not duplicate public
specifications.

## Accepted implementation constraints

- `session.url` and the raw handler remain byte-faithful and independently
  usable. Annotation never becomes a `serve` mode or raw-origin route.
- One review reuses the raw session's canonical grant but owns stable review
  state plus fresh trusted-shell and instrumented-content origins.
- Only the selected review entry may load the selection probe. Ordinary review
  assets use the same authorized-file seam and remain unmodified.
- The shell owns typed comments, drafts, and mutation APIs. Authored content is
  cross-origin and may forge anchor metadata but cannot read comments or invoke
  supervisor control.
- Element anchors contain bounded selector/path/tag/text context and a
  capture-time entry revision. Freeform feedback has no anchor. Text ranges are
  deferred.
- Queue success means the draft is durably committed outside every serving
  grant. Browser storage is not authoritative.
- Send atomically creates ordered immutable events. End commits the final batch
  and closes review origins; it does not acknowledge agent delivery.
- A returned feedback cursor is a delivered stream position. Only a later
  `--after` advances the acknowledged cursor. Retry favors duplicates over loss.
- One agent consumer and one active wait per review are explicit `0.1.0`
  limits.
- Stop preserves pending work. Deletion of drafts or unacknowledged events
  requires explicit discard; retry tombstones are bounded.
- Logs remain content-free diagnostics and never deliver feedback.
- Browser installation, launch, and automation stay outside the package.

## Workflow to preserve

```sh
htmlview serve ./report.html
htmlview review <session>
htmlview feedback --wait <review>
```

`review` never opens a browser. The shell starts in Annotate mode and offers an
Explore/Annotate switch. Queue persists a draft; Send publishes selected work;
Send & End publishes the final work and closes the review listeners. The agent
uses the returned cursor in its next feedback request after applying a batch.

A stopped, unended review resumes for the same canonical-root/public-entry
identity with its stable ID, drafts, and fresh origins. Ended reviews do not
resume. The no-argument home result keeps non-tombstone review IDs and pending
counts discoverable.

## Phase status

| Phase                                     | Status   | Outcome                                         |
| ----------------------------------------- | -------- | ----------------------------------------------- |
| 0. Contracts and decisions                | Complete | Public specs, ADRs, domain language, doc tests  |
| Prerequisite: Effect CLI/logging          | Complete | One final command model and diagnostic boundary |
| 1. Authorized reads and review lifecycle  | Complete | Review identity, origins, scopes, protocol      |
| 2. Durable feedback and agent delivery    | Pending  | Store, transitions, CLI/control operations      |
| 3. Instrumented content and trusted shell | Pending  | Entry probe, shell UI, browser boundaries       |
| 4. Security, fidelity, release hardening  | Pending  | Adversarial evidence and complete release gate  |

## Prerequisite: Effect CLI and logging

Complete [Phase 10 of the Effect plan](effect-v4-adoption.md#phase-10-effect-cli-and-diagnostic-logging)
before adding commands. Annotation must extend pinned Effect CLI directly, not
the parser being removed. The prerequisite also installs the diagnostic seam
whose redaction tests must cover later annotation values.

## Phase 1: authorized reads and review lifecycle

- **Complete:** characterize the raw file-open/response boundary and extract one
  deep authorized-file service. The shared seam owns canonical authorization,
  descriptor fencing, cleanup, and single-use bounded stream creation; raw HTTP
  retains validation order, MIME selection, headers, caching, and response
  piping.
- **Complete:** add review/document identity, stable records, two fresh exact
  authorities, child scopes, ready-before-output, reuse/resume, stop, and
  bounded home summaries to the strict v3 supervisor protocol and registry.
- **Complete:** keep review creation lazy so raw-only sessions acquire no review
  listener or browser surface.

Phase 1 implements the lifecycle behind strict private protocol operations and
in-memory bounded summaries. Phase 2 adds durable recovery and only then exposes
the public `review` command, avoiding a public lifecycle that cannot yet meet
the restart contract. Review records live outside the raw-session map, use the
canonical-root/public-entry identity, and share one mutation boundary with raw
session create/stop. A ready review owns separate shell and content child scopes;
both origins must pass readiness before the record becomes ready.

The characterization additions pass against the pre-extraction implementation
(19 integration tests) and the extracted boundary (23 focused tests). The full
current-platform `pnpm run check` gate passes 144 Vitest tests, black-box E2E,
seven Playwright checks, documentation/build validation, and package lifecycle.

## Phase 2: durable feedback and agent delivery

- Add a versioned, bounded, schema-validated annotation store with `0700`/`0600`
  permissions and durable atomic replacement. Fail closed on unsupported or
  corrupt state; add no migration layer until a second schema exists.
- Implement serialized draft, send, end, read, acknowledge, wait,
  delete/discard, recovery, resume, and tombstone transitions with typed errors.
- Add `review`, `feedback`, retained-review home summaries, and deletion to the
  Effect CLI tree and private protocol. Keep domain results TOON/JSON and native
  syntax/meta output text.
- Prove wait cancellation changes no persisted cursor/event state and a lost
  response can be retried.

Persistence precedes browser UI so Phase 3 cannot create an ephemeral side
channel that later needs replacing.

## Phase 3: instrumented content and trusted shell

- Add an HTML-token-aware entry transform that inserts one external probe
  reference without reserializing original bytes or weakening CSP.
- Bundle immutable in-memory shell/probe assets; write nothing beside served
  content.
- Implement the sandboxed cross-origin iframe, exact source/origin message
  validation, Explore/Annotate selection, shell-owned tooltip/freeform editor,
  draft list, Send, and Send & End.
- Report unsupported CSP, encoding, markup, framing, and multi-document
  navigation explicitly while leaving the raw URL usable.
- Keep the browser surface dependency-light and controller-independent.

## Phase 4: security, fidelity, and release hardening

- Complete every pending row in
  [`docs/SECURITY_VALIDATION.md`](../SECURITY_VALIDATION.md), including hostile
  authored code, CSRF/origin checks, postMessage spoofing, persistence bounds,
  concurrency, interruption, restart, and log canaries.
- Compare the raw contract before and after review creation at the byte, header,
  URL, path, Host, cache, method, confinement, and lifecycle boundaries.
- Add black-box and real-browser workflows for element/freeform feedback,
  native controls, reload/closure/restart, cursor retry, stale revision, CSP
  failure, End, explicit discard, and retained-work discovery.
- Update build/package checks, examples, install guidance, and macOS/Node 22
  Linux lifecycle evidence; keep browser controllers external.
- Run the complete release gate and final implementation/diet review.

## Deliberately deferred

- Remote review, accounts, identity, permissions, or collaboration
- Persistent pins, threads, resolution state, or source-control integration
- Automatic edits, selector-to-source mapping, built-in LLM calls, or agent
  replies in the review page
- Screenshots, visual diffs, accessibility interpretation, or automatic findings
- Browser launch, hooks, ambient integration, or controller SDKs
- Text-range/quote anchors and annotation across document navigation
- Automatic history retention, compaction, or draft expiry beyond retry
  tombstones

## Next action

The versioned private annotation store, bounds, relational validation, atomic
replacement, and orphan recovery are implemented. Continue Phase 2 by putting
the review registry behind that store and adding serialized
draft/event/cursor transitions.

## Completion gate

Annotation is complete only when a human can send element-targeted and freeform
feedback, one foreground agent command receives it durably across interruption,
raw serving remains byte-faithful and independent, review limitations are
explicit, private state stays outside every grant, and the complete release
matrix passes. Do not publish automatically.
