# Annotation MVP plan

- Status: Phases 0–6 complete; release-ready and unpublished
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

| Phase                                     | Status   | Outcome                                         |
| ----------------------------------------- | -------- | ----------------------------------------------- |
| 0. Contracts and decisions                | Complete | Public specs, ADRs, domain language, doc tests  |
| Prerequisite: Effect CLI/logging          | Complete | One final command model and diagnostic boundary |
| 1. Authorized reads and review lifecycle  | Complete | Review identity, origins, scopes, protocol      |
| 2. Durable feedback and agent delivery    | Complete | Store, transitions, CLI/control operations      |
| 3. Instrumented content and trusted shell | Complete | Entry probe, shell UI, browser boundaries       |
| 4. Security and fidelity hardening        | Complete | Adversarial matrix and authenticated readiness  |
| 5. Automatic selected-entry refresh       | Complete | Observe, notify, reload, preserve review state  |
| 6. Packaging and release matrix           | Complete | Measurements, release commands, and review pass |

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

**Complete.** One scoped observer per ready review combines fixed-path
filesystem hints with bounded metadata fallback checks, reauthorizes through
the shared file boundary, confirms byte revisions, and coalesces transitions.
The shell polls a same-origin bounded entry-state endpoint and stages only its
instrumented iframe through a one-use expected-revision capability, promoting
the candidate after authenticated probe readiness. Browser evidence covers
edit-only refresh, transform-time B→C→B races, failed-candidate preservation,
rapid and unchanged writes, atomic replacement, temporary unavailability,
transient poll failure, hidden/page-history pause and resume, terminal peer End,
multiple shell clients, stale editor clearing, draft revision continuity, and
raw fidelity.

## Phase 6: packaging and release matrix

- **Complete:** the `example:review` workflow, source-checkout and
  installed-package guidance, build/package checks, and macOS/Node 22 Linux
  installed review/observer lifecycle evidence are implemented and tested;
  browser controllers remain external.
- **Complete:** rerun the automatic-refresh resource and performance
  measurements against the recorded Phase 10 baseline, including one ready
  review with its bounded observer.
- **Complete:** the full release-command matrix and final implementation/diet
  review pass after the automatic-refresh resource and performance bounds were
  recorded.

### Release measurement evidence

Commit `a006c375b35c93c61c2404938a66653cdba87150` was measured on macOS
26.5.1 arm64 with Node 24.15.0 and pnpm 11.13.0. These are local medians, not
benchmarks. Package and install figures use one clean packed artifact; process
samples use the installed executable. An empty query uses a fresh state root
and does not launch a supervisor. Empty-supervisor RSS is sampled after its only
raw session stops; ready-review RSS is sampled after the review observer reports
the selected entry revision.

| Measure                                 | Phase 10 baseline | Annotation artifact | Change              |
| --------------------------------------- | ----------------- | ------------------- | ------------------- |
| Tarball                                 | 1,058,473 bytes   | 1,122,730 bytes     | +6.1%               |
| Packed files                            | 29                | 29                  | none                |
| Installed size including dependencies   | 3,908 KiB         | 4,976 KiB           | +27.3%              |
| Installed files                         | 47                | 137                 | +90                 |
| Version command median, 11 spawns       | 98.07 ms          | 90.87 ms            | -7.3%               |
| Empty query median, 7 fresh state roots | 132.88 ms         | 109.82 ms           | -17.4%              |
| Fresh `serve` readiness median, 7       | 236.43 ms         | 232.75 ms           | -1.6%               |
| Empty-supervisor RSS median, 7          | 75,968 KiB        | 85,264 KiB          | +12.2%              |
| Fresh `review` readiness median, 7      | —                 | 122.32 ms           | annotation baseline |
| Ready-review observer RSS median, 7     | —                 | 85,968 KiB          | +704 KiB vs empty   |

The package keeps the same packed file count. Installed size and file count
increase primarily because the token-aware transform adds external `parse5`
8.0.1 and `entities` 8.0.0 runtime trees rather than duplicating them into the
standalone bundles. Cold version, empty-query, and serving readiness show no
regression in this sample. The complete annotation service raises empty-daemon
RSS by 9,296 KiB from Phase 10; activating one bounded selected-entry observer
adds 704 KiB (0.8%) over that current empty supervisor.

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

Keep the release-ready candidate unpublished. Production promotion is outside
this plan and requires a later explicit action.

## Completion gate

Annotation is complete only when a human can send element-targeted and freeform
feedback, one foreground agent command receives it durably across interruption,
an agent edit to the original entry refreshes the ready review automatically,
raw serving remains byte-faithful and independent, review limitations are
explicit, private state stays outside every grant, and the complete release
matrix passes. Do not publish automatically.

This gate is satisfied for the unpublished `0.1.0` release candidate.
