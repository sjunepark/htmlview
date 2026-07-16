# Annotation MVP Plan

## Status

Human annotation is required for `0.1.0`. The raw-serving implementation is
complete, but the release is not ready until this plan is implemented and the
product, CLI, architecture, threat-model, and decision documents agree with it.

Phase 0 is complete. ADRs 0008–0009 and the public product, CLI, architecture,
threat-model, README, domain-language, and documentation contract updates lock
the security, fidelity, persistence, anchoring, workflow, CLI, and diagnostic
logging choices. Runtime implementation has not started. The Effect CLI and
logging slice is the next prerequisite; annotation Phase 1 follows it.

| Phase                                     | Status   |
| ----------------------------------------- | -------- |
| 0. Contracts and decision records         | Complete |
| Prerequisite: Effect CLI/logging Phase 10 | Next     |
| 1. Shared confined reads/review lifecycle | Pending  |
| 2. Durable feedback/agent delivery        | Pending  |
| 3. Instrumented content/trusted shell     | Pending  |
| 4. Security, fidelity, release hardening  | Pending  |

## Product intent

`htmlview` should support two related jobs without conflating their fidelity
contracts:

1. An agent opens the existing raw URL to inspect, interact with, or run
   end-to-end checks against the authored artifact.
2. A human opens a separate review URL, selects an element or leaves page-level
   feedback, writes a change request such as “increase padding,” and sends it
   to the agent as structured prompt data.

An agent may also open the review URL to inspect the review workflow, but only
the raw URL is an application-fidelity target.

The review loop is local-first and browser-neutral. `htmlview` returns URLs but
does not install, launch, or automate a browser. Remote sharing, user accounts,
multi-user attribution, durable comment threads, and automatic source edits
are outside the MVP.

## Reference workflow

The design was compared with Lavish AXI at upstream commit
`55045850f61e7b23c8dbf8cc30d92bd6e31649d2` (`0.1.42`). Its useful pattern is
the separation of:

- a detached server and browser session;
- a browser-side annotation queue persisted outside the artifact after send;
  and
- a foreground `poll` command whose structured completion returns feedback to
  the invoking agent.

The MVP adopts that separation. It does not adopt Lavish's permissive network
binding, browser launching, raw-path transformation, destructive feedback read,
lexical-only file confinement, or reliance on server logs as an agent wake-up
channel.

## Confirmed boundaries

- `session.url` remains the byte-faithful raw URL and keeps its existing
  meaning, handler, origin, and readiness contract.
- Annotation is an explicit consumer created after `serve`; it is not a
  `serve` mode and never reserves routes on the raw origin.
- The review representation may be instrumented, but it must use separate
  random `.localhost` origins and disclose that it is not fidelity-equivalent
  to the raw page.
- Source files and served directories are always read-only. Review assets,
  drafts, feedback, and lifecycle state live beneath htmlview's existing
  user-private state directory. Canonical state/grant overlap is rejected in
  either direction, so neither directory can contain the other.
- Browser-facing review endpoints can submit review data only. Serving,
  stopping, listing, root selection, and other supervisor control remain on
  the private Unix-domain socket.
- The first release remains loopback-only and does not gain a public-bind or
  remote-review escape hatch.

## Default workflow and CLI contract

The accepted command flow is:

```sh
htmlview serve ./report.html
htmlview review <session>
htmlview feedback --wait <review>
```

1. `serve` remains short-lived and returns only after the raw URL is ready.
2. `review <session>` lazily creates, reuses, or resumes a review, then returns
   its opaque identifier, instrumented URL, associated raw URL, and fidelity
   notice. A stopped unended review for the same document identity keeps its ID
   and drafts but receives fresh origins. It never opens a browser.
3. The human uses the review URL. The page starts in annotation mode and offers
   an explicit Explore/Annotate toggle so authored controls remain usable.
4. Selecting an element opens a tooltip-style comment editor owned by the
   trusted review shell; freeform feedback has no target. Queueing persists a
   draft; Send atomically makes the selected drafts available to the agent.
5. `feedback <review>` returns the current state and any available feedback
   without waiting. `feedback --wait <review>` long-polls until feedback is sent or the review
   ends. Wait progress and heartbeats go to stderr; stdout contains one final
   TOON or JSON result.
6. After applying a batch, the agent follows the returned cursor-bearing next
   command to acknowledge that batch and wait for newer feedback. Stable event
   IDs make retry and duplicate handling explicit; feedback is never deleted
   merely because a response started.
7. Stopping the serving session closes its raw and review listeners. Drafts and
   sent but unacknowledged feedback remain in private state. Once a review is
   ended and its final cursor is acknowledged, its active state is reduced to
   a bounded retry tombstone before final removal.

The no-argument home result includes bounded non-tombstone review summaries
with IDs, lifecycle status, associated or originating session, draft count, and
unacknowledged count. Durable feedback therefore remains discoverable and
cleanable even if the agent loses an earlier command result.

The browser offers Send & End for a final batch. Ending with unsent drafts must
require an explicit discard confirmation. After the final state and response
are committed, End closes both review origins but leaves the raw session live;
review shutdown never silently drops drafts.

`review delete <review>` removes an empty or fully acknowledged review.
Deleting drafts or sent, unacknowledged feedback requires an explicit
`--discard-feedback` flag and returns the discarded counts. Repeating either
successful form is an idempotent success while its bounded tombstone remains.
Successful deletion closes any live review origins before committing the
deletion result and does not stop the raw session.

`serve` must not become a foreground development server. Detached diagnostics
or log lines cannot reliably resume an agent turn, would mix operational output
with domain feedback, and would reverse the accepted non-blocking contract.
There is no portable way for a local server to inject a prompt into every agent
harness. Completion of the foreground structured wait is the MVP integration;
feedback remains queued when no agent is waiting.

### Logical result defaults

`review` returns a minimal result shaped like:

```json
{
  "review": {
    "id": "rv_...",
    "status": "ready",
    "url": "http://...localhost:.../...",
    "reused": false
  },
  "session": {
    "id": "...",
    "url": "http://...localhost:.../report.html"
  },
  "grant": {
    "root": "/workspace",
    "access": "read_all_regular_files_beneath_root"
  },
  "fidelity": "instrumented_review"
}
```

`feedback` returns a definitive event count, cursor, review status, and a
bounded array of prompt events. TOON remains the default and `--json` emits the
same logical value. Empty feedback is a successful, explicit result.
`docs/CLI.md` is authoritative for command, flag, schema, error, cursor, and
exit details. Native Effect CLI help, version, completion, log-level, and syntax
behavior is intentionally outside the TOON/JSON domain-result model.

## Review-page architecture

Use two fresh review origins in addition to the raw origin:

- a trusted shell origin owns the comment editor, draft state API, send action,
  review status, and browser-facing mutation endpoints;
- an instrumented content origin serves the selected root with the same
  confinement checks as raw serving, transforms only the entry response, and
  hosts a small selection probe loaded by that response.

The shell embeds the content origin in a sandboxed iframe. Because shell and
content use different hostnames, the iframe may retain its content origin for
same-origin assets, modules, and fetches without gaining DOM access to the
shell. The probe reports a schema-validated target and viewport rectangle with
`postMessage`; the shell positions the tooltip and owns the textarea. The
shell validates both `event.source` and the exact content origin.

Both review hostnames are reused only while that review's listeners remain
live. Recreating a stopped review issues fresh hostnames so browser storage,
cookies, caches, and service workers cannot cross review lifetimes.

Authored scripts can still interfere with the page or forge target messages
from their own frame. They must not be able to read typed comments, call the
shell's mutation API, access annotation state, or invoke supervisor control.
This is the explicit MVP trust posture: reviewed HTML is trusted enough to
render, while feedback confidentiality and control authority are isolated from
it where the browser boundary permits.

Review routes must use exact Host checks, exact Origin and fetch-metadata checks
for mutations, same-origin resource policy for state reads, no permissive CORS,
bounded headers/bodies/connections, and non-guessable origin labels. Random
labels are isolation tools, not authorization credentials. Review data is
treated as untrusted input at every shell, protocol, persistence, CLI-output,
and rendering boundary.

## Instrumentation and fidelity

- Keep `createStaticHandler` and every raw response path unchanged. Extract
  shared authorized-file primitives only when both raw and review handlers can
  use them without weakening raw invariants.
- Transform only the review entry document. Serve review subresources from the
  authorized root without body changes, apart from explicit in-memory review
  assets that cannot collide with raw paths.
- Insert one external selection-probe script with an HTML-token-aware transform
  that preserves all original entry bytes outside the inserted tag. Do not
  parse and reserialize the whole document.
- Never remove or weaken an authored CSP. If CSP, document encoding, malformed
  markup, or another condition prevents safe instrumentation, keep the raw URL
  available and show a specific review error instead of silently degrading.
- The review contract must disclose iframe, sandbox, top-level browsing
  context, event interception, injected DOM/style, storage, and CSP
  differences. Agent E2E and fidelity assertions use the raw URL.
- The MVP instruments only the selected entry document and its live SPA DOM.
  Navigation to another HTML document is not silently transformed; the shell
  reports that annotation is unavailable there while its raw content remains
  reachable under the grant.

The browser probe and shell should be maintained as ordinary typed source and
bundled into the existing supervisor artifact at build time unless measured
evidence shows that separate published assets are simpler. Review resources
are served from immutable in-memory bytes, not written beside user content.

## Annotation anchors

Each feedback event gets a stable ID, creation time, bounded comment, review
ID, entry route, and capture-time SHA-256 revision of the entry bytes. Anchor
schema version 1 supports:

- **Element:** a unique-ID or bounded structural CSS selector, bounded DOM-path
  fallback, tag, and normalized text excerpt. Never capture form values,
  inline script/style, credential-bearing URLs, or arbitrary `data-*`
  payloads.
- **Freeform:** a review-level message with no DOM target.

Geometry may help position the current tooltip but is not a durable anchor and
is not required in agent output. Runtime-generated element IDs are not durable
identity. Selector depth, text, paths, and comments all have explicit size
limits.

The MVP captures an anchor once and sends it as prompt context; it does not
maintain permanent pins or silently reattach comments after document changes.
A queued draft remains visible in the shell after reload but is never silently
retargeted. The entry revision lets the agent recognize feedback captured
against older bytes.

## Persistence and delivery

Use a versioned annotation store beneath the existing private state directory,
which must be canonically disjoint from every serving root in either direction.
Keep directory permissions at `0700`, files at `0600`, validate every decoded
record, cap per-review and global state, and use durable atomic replacement. Do
not use browser local storage as the authoritative queue.

The private document identity is the canonical root plus public entry route,
matching raw-session reuse semantics; a different root or authorized route is
a different review. A random public review ID addresses the record and remains
stable across supervisor restarts, but is not an authorization credential.
A stopped unended review resumes against a newly live raw session for the same
document identity with fresh browser origins. Ended reviews never resume.
On supervisor recovery, any `ready` record not owned by the current process is
made `stopped` before a command can observe it.

Persist drafts when the human queues them so browser closure or reload does not
lose work. Sending transitions selected drafts into an ordered append-only
feedback stream. Agent reads are cursor-based and non-destructive:

- a response carries stable event IDs and its highest cursor;
- the next request may acknowledge through that cursor while waiting for newer
  events;
- an interrupted or repeated read can return duplicates but cannot lose an
  unacknowledged event; and
- the single-agent-consumer assumption is explicit for `0.1.0`.

Reject new drafts with an actionable browser and CLI error when a bound is
reached; never evict unseen feedback silently. Acknowledged events may be
removed. Ended and fully acknowledged reviews become small tombstones retaining
their final cursor and deletion result for 24 hours so acknowledgement and
delete retries remain idempotent, then expire. Drafts and sent,
unacknowledged feedback do not expire silently; the explicit delete command is
the recovery path when global bounds are reached. Exact byte and event limits
are implementation constants covered by contract tests, not
caller-configurable v0.1.0 flags.

## Implementation milestones

### 0. Contracts and decision record

Status: Complete on 2026-07-16. Documentation validation and relative-link
checks pass.

- Add ADR 0008 for the review origins, active-page trust posture,
  instrumentation/fidelity boundary, anchor schema, persistence, and cursor
  delivery semantics.
- Update `docs/PRODUCT.md`, `docs/CLI.md`, `ARCHITECTURE.md`,
  `docs/THREAT_MODEL.md`, README, and contract tests before implementation.
- Amend ADR 0004 so the existing state exclusion is symmetric. A root inside
  runtime state is as invalid as a root containing runtime state; both would
  violate read-only served directories once annotations or logs are written.

### Prerequisite: Effect CLI and logging

Status: Next in the
[Effect v4 adoption plan](effect-v4-adoption.md#phase-10-effect-cli-and-diagnostic-logging).

- Replace the custom parser, manual help model, and dispatcher before adding
  `review` and `feedback`, so annotation extends one final command tree.
- Preserve TOON/JSON domain values while adopting native Effect CLI text
  help/version/usage behavior and exit `1` for syntax failures.
- Install stderr-only foreground logging and bounded, rotated, private
  supervisor JSONL. Logs remain diagnostics and must exclude comments,
  anchors, DOM/HTML excerpts, form values, credentials, file content, raw
  protocol payloads, and attacker-controlled strings.

### 1. Shared confined reads and review lifecycle

Status: Pending until the Effect CLI/logging prerequisite passes.

- Extract a deep authorized-file service from `src/serving/http.ts` while
  preserving the raw handler and its tests byte-for-byte at the boundary.
- Add review identity, child scopes, two exact review authorities, readiness,
  reuse/resume, stop, bounded home summaries, and supervisor control schemas.
- Keep review creation lazy so raw-only sessions pay no browser surface or
  listener cost.

### 2. Durable feedback and agent delivery

- Add the bounded, versioned, atomic store and unsupported-version/corruption
  policy. Do not add a compatibility migration path until a second persisted
  schema exists.
- Add draft, send, end, cursor-read, acknowledge, delete/tombstone, and
  long-poll state transitions with typed errors and scoped cancellation.
- Add `review` and `feedback` to the Effect CLI command tree, private control
  routes, TOON/JSON domain results and operational errors, and contextual next
  commands. Native help and syntax errors retain Effect CLI's text contract.

### 3. Instrumented content and trusted shell

- Add the entry-only HTML transform, in-memory probe route, shell route, iframe
  sandbox, origin/message validation, and explicit instrumentation failures.
- Implement Explore/Annotate mode, element hover/selection, tooltip
  positioning, native control behavior, draft list, Send, and End review
  against the durable Phase 2 transitions.
- Keep browser resources dependency-light and independent of any controller.

### 4. Security, fidelity, and release hardening

- Extend the threat model and adversarial evidence for review origins, CSRF,
  hostile authored scripts, stored content, postMessage spoofing, CSP, state
  permissions, bounds, concurrency, interruption, and cleanup.
- Add raw-versus-review fidelity evidence and verify raw bodies, headers, URLs,
  paths, and lifecycle remain unchanged after review creation.
- Update build/publication checks, package smoke tests, examples, install docs,
  and the complete macOS/Linux release matrix.

## Required validation

- Unit tests for element anchors, bounded schemas, state transitions, cursor
  retry, delete/tombstone expiry, and HTML-token-aware injection.
- Raw HTTP regressions proving review creation never changes or reserves a raw
  route and never weakens traversal, symlink, Host, method, or byte checks.
- Root/state regressions for equality, containment in either direction, and
  symlinked overlap before any annotation or diagnostic state is written.
- Review integration tests for exact Host/Origin enforcement, CORS absence,
  capability separation, body and connection bounds, state permissions,
  atomic recovery, restart adoption, long-poll cancellation, cleanup, and the
  cross-origin embedding behavior of review response headers.
- Real-browser E2E for element and freeform comments, Explore/Annotate
  switching, native controls, queue/send/end, browser reload and closure,
  supervisor restart, cursor retry, stale document revision, authored CSP
  failure, and an authored-script attempt to reach shell state or mutation
  APIs.
- Black-box CLI tests for every TOON/JSON domain success, expected operational
  failure, empty state, idempotent reuse/stop, interruption, and next command;
  plus separate assertions for native text help and syntax failures.
- Diagnostic tests proving annotation content never reaches foreground or
  supervisor logs and that feedback is delivered only through the durable
  cursor queue.
- Release checks with at least two independently supplied browser controllers,
  while keeping both outside runtime dependencies.

## Deliberately deferred

- Remote review, accounts, reviewer identity, permissions, or collaboration
- Persistent resolved/unresolved comment threads or source-control integration
- Automatic source edits, selector-to-source mapping, or LLM invocation inside
  the supervisor
- Screenshots, visual diffs, accessibility interpretation, or automatic layout
  findings
- Browser launching, hooks, ambient agent integration, or a controller SDK
- Agent-to-human chat beyond an optional later structured reply field
- Text-range comments, quote anchoring, and cross-node selection
- Annotation across multi-document navigation
- Automatic review-history retention, compaction, or draft expiry beyond the
  bounded retry tombstone

## Progress

- 2026-07-16: Completed Phase 0. Added the domain language, accepted ADR 0008,
  aligned the public product/CLI/architecture/threat-model/README contracts,
  and added executable documentation checks for the raw/review boundary,
  command surface, origin isolation, anchoring, and durable cursor semantics.
  The cross-cutting review added retained-review discovery/resume and explicit
  End/Delete listener closure, aligned the package surface, moved persistence
  before browser UI, and deferred text-range anchors to keep `0.1.0` narrow.
- 2026-07-16: Accepted ADR 0009 and refreshed the annotation contract for the
  native Effect CLI/logging boundary. The CLI/logging migration now precedes
  Phase 1; feedback remains a durable domain queue and never a log stream.

## Next action

Complete Phase 10 of the Effect adoption plan and its CLI/logging validation
gate. Then begin Phase 1 with characterization tests around the existing raw
authorized-file path and extract the shared confined-read seam without changing
any raw HTTP response. Add review identity and lifecycle protocol types only
after the raw regression harness is in place. Do not publish automatically.

## Completion gate

Annotation is complete for `0.1.0` only when a human can submit element-targeted
and freeform feedback; a foreground agent command receives it without polling
logs or losing it across browser/supervisor interruption; raw serving remains
byte-faithful and independently usable; review limitations are explicit; all
state remains private and outside the grant; and the full release matrix passes.
Do not publish before this gate is met.
