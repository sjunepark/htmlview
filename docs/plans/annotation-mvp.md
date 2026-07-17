# Annotation MVP plan

- Status: Phases 0–4 complete; Phase 5 automatic refresh next
- Updated: 2026-07-17
- Parent: [`PLAN.md`](../../PLAN.md)
- Decision: [ADR 0008](../decisions/0008-separate-raw-serving-from-instrumented-review.md)
- CLI boundary: [ADR 0009](../decisions/0009-adopt-effect-cli-and-logging.md)

## Objective

Ship human annotation in `0.1.0` without changing the raw URL or writing into a
served project. A human selects an element or leaves freeform feedback in a
separate review surface; one agent receives durable structured events through a
foreground CLI operation. After the agent edits the selected entry HTML, the
ready review refreshes its own iframe automatically so the same human-agent
feedback loop can continue.

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
- A ready review owns one bounded observer for its original selected entry.
  Confirmed byte changes notify the trusted shell and refresh only its
  instrumented iframe; raw responses and already-loaded raw consumers remain
  passive.
- Observation is limited to the selected entry path. It does not watch the
  whole serving grant, switch to a newly created output file, launch or control
  a browser, or turn raw serving into a development server.
- Browser installation and product browser launch or automation stay outside
  this repository. Development-only browser validation remains package-excluded.

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
While the review remains ready, an edit to the original entry automatically
reloads the review iframe; the human uses Send rather than Send & End to keep
iterating. The raw URL serves the latest bytes on its next request, but
`htmlview` does not force unrelated raw tabs or other consumers to refetch.

A stopped, unended review resumes for the same canonical-root/public-entry
identity with its stable ID, drafts, and fresh origins. Ended reviews do not
resume. The no-argument home result keeps non-tombstone review IDs and pending
counts discoverable.

## Phase status

| Phase                                     | Status   | Outcome                                          |
| ----------------------------------------- | -------- | ------------------------------------------------ |
| 0. Contracts and decisions                | Complete | Public specs, ADRs, domain language, doc tests   |
| Prerequisite: Effect CLI/logging          | Complete | One final command model and diagnostic boundary  |
| 1. Authorized reads and review lifecycle  | Complete | Review identity, origins, scopes, protocol       |
| 2. Durable feedback and agent delivery    | Complete | Store, transitions, CLI/control operations       |
| 3. Instrumented content and trusted shell | Complete | Entry probe, shell UI, browser boundaries        |
| 4. Security and fidelity hardening        | Complete | Adversarial matrix and authenticated readiness   |
| 5. Automatic selected-entry refresh       | Next     | Observe, notify, reload, preserve review state   |
| 6. Packaging and release matrix           | Pending  | Installed workflow and complete release evidence |

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
  bounded home summaries to the strict v4 supervisor protocol and registry.
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

- **Complete:** add a versioned, bounded, schema-validated annotation store with `0700`/`0600`
  permissions and durable atomic replacement. Fail closed on unsupported or
  corrupt state; add no migration layer until a second schema exists.
- **Complete:** implement serialized draft, send, end, read, acknowledge, wait,
  delete/discard, recovery, resume, and tombstone transitions with typed errors.
- **Complete:** add `review`, `feedback`, retained-review home summaries, and deletion to the
  Effect CLI tree and private protocol. Keep domain results TOON/JSON and native
  syntax/meta output text.
- **Complete:** prove wait cancellation changes no persisted cursor/event state and a lost
  response can be retried.

Persistence precedes browser UI so Phase 3 cannot create an ephemeral side
channel that later needs replacing.

## Phase 3: instrumented content and trusted shell

- **Complete:** add an HTML-token-aware entry transform that inserts one external probe
  reference without reserializing original bytes or weakening CSP.
- **Complete:** bundle immutable in-memory shell/probe assets; write nothing beside served
  content.
- **Complete:** implement the sandboxed cross-origin iframe, exact source/origin message
  validation, Explore/Annotate selection, shell-owned tooltip/freeform editor,
  draft list, Send, and Send & End.
- **Complete:** report unsupported CSP, encoding, markup, framing, and multi-document
  navigation explicitly while leaving the raw URL usable.
- **Complete:** keep the browser surface dependency-light and controller-independent.

## Phase 4: security and fidelity hardening

- **Complete:** close every control-specific row in
  [`docs/SECURITY_VALIDATION.md`](../SECURITY_VALIDATION.md), including hostile
  authored code, CSRF/origin checks, postMessage spoofing, persistence bounds,
  concurrency, interruption, restart, and log canaries.
- **Complete:** compare the raw contract before and after review creation at the byte, header,
  URL, path, Host, cache, method, confinement, and lifecycle boundaries.
- **Complete:** add black-box and real-browser workflows for element/freeform feedback,
  native controls, reload/closure/restart, cursor retry, stale revision, CSP
  failure, End, explicit discard, and retained-work discovery.
- **Complete:** authenticate selected-entry readiness with one-use probe URLs
  and shell-redeemed leases; reject probe fetch/replay and content-origin
  service-worker interception; keep same-origin nested iframe loads raw; and
  capture the parent/messaging primitives before authored scripts so later
  navigation cannot reactivate annotation.
- **Complete:** require a shell-minted, exact-entry, one-use capability before
  transforming a navigation; remove its reserved query before authored code;
  bind target messages to the active probe lease/revision; and preserve dirty
  editor state under forged-message floods.
- **Complete:** persist stop before listener teardown and delete through a
  stopped lifecycle barrier, leaving every failed transition retryable as
  ready-and-live or stopped-and-closed.

## Phase 5: automatic selected-entry refresh

- Characterize the existing manual-reload path first. Replace its browser test
  trigger with an edit-only expectation while retaining explicit reload tests
  for navigation, authenticated probe readiness, and recovery behavior.
- Add one review-owned, scoped observer for the fixed pathname represented by
  the public entry route, not its initial canonical target. It must detect
  in-place writes and atomic replacement, coalesce bursts, and treat filesystem
  notifications or metadata changes only as hints. Reauthorize the path's
  current regular-file target through the authorized-file boundary and compare
  a confirmed byte revision before publishing a content change. Model
  availability changes separately: missing, forbidden, or unreadable may notify
  the shell without a revision but cannot trigger an iframe reload.
- Add a bounded shell-origin notification mechanism. It carries only a
  review-local availability state or opaque confirmed revision, never a
  filesystem path, source bytes, comment, anchor, or arbitrary diagnostic
  value. Exact Host and same-origin browser protections remain authoritative.
  Keep the contract transport-neutral until implementation evidence chooses
  bounded polling, push, or an equivalent mechanism.
- On a confirmed new revision, reload only the review content iframe. Clear
  selection, highlight, and unsaved element context tied to the prior DOM;
  preserve durable drafts and their capture revisions. Admit annotation only
  after the replacement document completes the existing authenticated probe
  handshake.
- If the fixed pathname is missing, forbidden, or unreadable, retain the last
  successfully rendered iframe, show a shell-owned unavailable state, and
  disable annotation rather than navigating to an error response. Boundedly
  retry observation. If authorized readable bytes return unchanged, re-enable
  without reload; if their revision differs, reload. Readable but unsupported
  bytes use the existing explicit limitation flow.
- Keep the raw route byte/header/URL/cache/lifecycle contract identical.
  `htmlview` does not inject a reload client, mutate source, or force arbitrary
  browser/controller/HTTP consumers to refetch the raw URL.
- Bound observation cadence, coalescing, in-flight notification work, retries,
  and shutdown. A ready review owns the resources; failed acquisition, stop,
  End, deletion, supervisor shutdown, and interruption close them idempotently.
  Observation alone must not keep a stopped review or empty supervisor alive.
- Validate edit → automatic review refresh → new feedback in one real-browser
  loop. Cover rapid writes, unchanged-byte touches, atomic replacement,
  temporary missing/unsupported entries, multiple shell clients, preserved
  old-revision drafts, stale selections, disconnect/reconnect, cancellation,
  restart, cleanup, and raw before/after fidelity.

## Phase 6: packaging and release matrix

- Update build/package checks, examples, install guidance, and macOS/Node 22
  Linux lifecycle evidence; keep browser controllers external.
- Run the complete release gate and final implementation/diet review after the
  automatic-refresh resource and performance bounds are recorded.

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

Implement Phase 5 before packaging. Start with a failing real-browser workflow
that edits the original entry without calling `location.reload()`, then add the
review-owned observer and trusted-shell notification path while proving the raw
contract is unchanged. Phase 6 follows only after the automatic-refresh
lifecycle, security, and resource matrix passes.

## Completion gate

Annotation is complete only when a human can send element-targeted and freeform
feedback, one foreground agent command receives it durably across interruption,
an agent edit to the original entry refreshes the ready review automatically,
raw serving remains byte-faithful and independent, review limitations are
explicit, private state stays outside every grant, and the complete release
matrix passes. Do not publish automatically.
