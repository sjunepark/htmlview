# ADR 0008: Separate raw serving from instrumented review feedback

- Status: Accepted
- Date: 2026-07-16
- Amended: 2026-07-17 to authenticate document navigation/readiness and target
  messages, harden lifecycle persistence, and make entry plus served-resource
  refresh review-owned, revision-bound, automatic, and terminally bounded
- Extends: [ADR 0001](0001-separate-serving-from-browser-control.md)
- Related: [ADR 0009](0009-adopt-effect-cli-and-logging.md) defines the CLI and
  diagnostic boundary

## Context

Human annotation is a core `0.1.0` feature. Agents and humans need a shared
review surface where a human can select an element or leave page-level
feedback, then deliver it to the active agent. The existing raw URL must
simultaneously remain byte-faithful for agent exploration and end-to-end browser
checks.

One response cannot satisfy both contracts: annotation requires browser
instrumentation, while the raw handler promises not to transform source bytes.
Putting trusted annotation controls in the authored document would also let its
scripts read comments or invoke browser-facing state changes. Keeping feedback
only in a browser tab or detached-process log would make agent delivery fragile.

## Decision

Keep the raw session and `session.url` unchanged. Create annotation as an
explicit review attached to a live raw session:

- `htmlview review <session>` lazily creates, reuses, or resumes a review and
  returns its review URL together with the associated raw URL and serving
  grant. A stopped, unended review for the same canonical-root/public-entry
  identity keeps its ID and drafts but receives fresh origins; ended reviews
  never resume.
- The review URL is the shared annotation surface for humans and agents. The
  raw URL remains the only fidelity and end-to-end testing reference.
- A review uses a trusted shell origin and a different instrumented-content
  origin, both fresh random `.localhost` authorities bound to loopback. Neither
  authority is added to the raw listener.
- The shell owns the comment editor, persisted drafts, send/end actions, and
  browser-facing state API. The content origin serves root-confined assets and
  transforms only the selected entry to load a bounded selection probe.
- The content iframe retains its own origin for authored same-origin assets and
  scripts but cannot access the shell DOM or state API. The probe reports target
  context through a strictly validated message boundary. Target messages carry
  the active one-use probe lease and entry revision, so authored calls to
  `postMessage` cannot clear, replace, or submit shell editor state. Anchor
  meaning remains untrusted because the probe observes an authored DOM that a
  malicious page controls.
- Only the shell's cross-site iframe-navigation requests for the selected entry
  receive instrumentation; same-origin nested iframe loads remain raw. The
  shell first mints a bounded, one-use navigation capability tied to the exact
  entry. Requests without it receive raw bytes, and malformed, expired, or
  replayed capability requests fail closed. The parser-blocking probe removes
  the reserved query from the document URL before authored scripts run. Each
  transformed response then references a one-use random probe URL. That URL serves
  one uncached script containing a separate random lease which is absent from
  the HTML; the shell must redeem the lease through its protected mutation API
  before the entry revision becomes active. Replays, ordinary authored fetches,
  synthetic mode messages, and forged `probe_ready` messages fail closed. The
  parser-blocking probe runs before authored scripts and captures the real
  parent plus pristine messaging primitives, keeping its lease inaccessible
  even if authored code later shadows browser globals.
  Service-worker script requests are unavailable on the fresh content origin
  so authored code cannot intercept the one-use response. This authenticates
  document readiness and binds later target messages to that document, not the
  semantic truth of target metadata derived from authored DOM.
- Review mutations require the exact shell authority and origin. Browser routes
  never expose raw-session creation or stop, root selection, listing, or other
  supervisor control, which remains on the user-private Unix socket.
- Authored CSP and other document policy are not weakened. If safe
  instrumentation cannot run, the review reports that limitation while the raw
  URL remains available.
- A ready review owns one bounded refresh observer. It always observes the fixed
  selected-entry pathname represented by the public entry route. It may also
  track a bounded set of non-entry regular files only after the review content
  origin completes an authorized GET and reports the streamed byte hash. It
  rejects resources outside those bounds before the handler hashes their bodies,
  reserves concurrent admissions until their response completes or aborts,
  watches only those exact paths' parent directories and retains polling as the
  authoritative fallback; it never recursively watches the serving grant. A
  confirmed entry revision resets that tracked-resource generation and ignores
  late completions from the superseded document. Review-content assets use
  `no-store` responses without conditional 304 reuse; raw cache behavior stays
  unchanged.
- After each hint or fallback check, reauthorize the current target and confirm
  its bytes before changing the deterministic entry or aggregate resource
  revision. This supports atomic replacement and symlink retargeting while
  rejecting root escape, byte-identical writes, unrequested files, and random
  watcher noise. Resource count, size, watcher, cadence, and concurrency limits
  remain implementation bounds rather than grant discovery mechanisms. Forced
  fallback byte verification rotates across the tracked set rather than hashing
  every unchanged resource in the same poll.
- The observer may notify the shell of an authorized availability-state change
  without an entry byte revision. A content-change notification requires a
  confirmed entry revision or aggregate served-resource revision different from
  the rendered state; only that notification can trigger an iframe reload.
- On a confirmed change, the shell automatically reloads only its
  instrumented-content iframe. It stages the replacement under the same content
  origin and promotes it only after authenticated probe readiness, so a raced
  or failed response cannot replace the last successfully rendered document.
  Preserve durable drafts with their capture revisions, defer resource reloads
  while unsaved feedback is dirty, and clear transient selection state tied to
  a replaced entry DOM. Keep observed, pending, and successfully rendered
  resource revisions distinct so a change during staged navigation queues one
  coalesced follow-up. The raw
  listener receives no notification route or injected reload client, so
  already-loaded raw consumers remain responsible for refetching.
- Observer-driven navigation binds the confirmed expected revision into the
  shell-minted one-use capability. The content handler recomputes the bytes'
  revision before creating a probe or recording an instrumentation limitation;
  a mismatch is rejected and retried rather than admitted as the active review.
  Initial and explicit manual navigation omit the expectation so Explore
  behavior remains independent of entry observation.
- Each shell keeps at most one two-second entry-state request active. It pauses
  and aborts that request while the document is hidden or in page history,
  resumes on return, and becomes permanently read-only after successful local End or
  three consecutive request/response failures. Peer End, stop, deletion, and
  listener shutdown therefore converge on a bounded closed state instead of an
  unbounded reconnect loop.
- If the fixed entry pathname is temporarily missing, forbidden, or unreadable,
  keep the last successfully rendered iframe visible but disable annotation and
  show a shell-owned unavailable status. Do not navigate the iframe to an error
  response. Re-enable it when the pathname again resolves to authorized readable
  bytes; reload only when those bytes have a different revision. A confirmed
  readable but unsupported document follows the existing explicit review-
  limitation flow.

The review shell starts in Annotate mode and offers an Explore/Annotate switch.
Element selection opens a shell-owned tooltip editor; freeform feedback has no
target. Queueing persists a draft, Send publishes selected drafts, and Send &
End publishes a final batch. Ending with unsent drafts requires explicit
discard confirmation. After the final state and HTTP response are committed,
End closes both review origins without stopping the raw session.

Feedback events use anchor schema version 1 and include a stable ID, bounded
comment, public entry route, and SHA-256 revision of the entry bytes at capture:

- element anchors contain a bounded structural selector, DOM-path fallback,
  tag, and optional normalized text excerpt; and
- freeform events omit the anchor.

Anchors never capture form values, inline script/style, credential-bearing
URLs, arbitrary `data-*` values, or geometry as durable feedback. The MVP
captures once and does not maintain pins or silently reattach an anchor after
the entry changes.

Use a separate foreground feedback operation rather than changing `serve` into
a terminal-attached process:

- `htmlview feedback [--wait] [--after <cursor>] <review>` returns sent feedback
  as the ordinary TOON/JSON command result. `--wait` long-polls; `--after`
  acknowledges earlier events before reading or waiting for newer ones.
- Detached supervisor logs remain diagnostics only. Feedback waits write
  progress to stderr and one final structured result to stdout.
- One agent consumer per review is the `0.1.0` contract. Stable event IDs and
  non-destructive cursor reads favor duplicate delivery over feedback loss.
- `--after` accepts a cursor returned by an earlier read and atomically
  acknowledges through it. A cursor beyond the highest previously returned
  position is rejected without state change. Only one foreground wait may be
  active per review.

Persist review state under htmlview's existing private state directory, never
under or above the serving grant; canonical state/grant overlap in either
direction is invalid. Queueing creates a durable annotation draft; sending
creates ordered immutable feedback events. Stopping listeners does not discard
unacknowledged feedback. Supervisor recovery converts any orphaned `ready`
record to `stopped` before serving commands. Ended, acknowledged reviews retain
only a bounded 24-hour retry tombstone before deletion.
`htmlview review delete <review>`
deletes a review with no drafts and no unacknowledged feedback; discarding
either requires `htmlview review delete --discard-feedback <review>`. An ended
review does not silently reopen.
If the raw session remains live, a later `review <session>` starts a new review
with a new identifier and origins. Successful deletion closes any live review
origins before committing the deletion result; it never stops the raw session.
The transition is a durable saga: persist `ready` to `stopped`, release the
store mutation permit while closing live origins, then commit the deletion
tombstone. Stop operations likewise persist every review attached to the
session before closing listeners. Failures therefore converge on either
ready-and-live or stopped-and-closed state, and retries remain safe.
This retry guarantee applies to interactive control operations. A forced
supervisor close always tears down disclosure listeners before releasing the
control socket and ownership lock, even when private-state persistence is
unavailable; the existing startup recovery then normalizes any orphaned
`ready` record to `stopped`.
The no-argument home result lists bounded non-tombstone review summaries with
IDs, statuses, and pending counts so retained data remains discoverable and
cleanable after listener or supervisor stop.

The MVP is a one-way queue. It does not keep submitted comments as visible
pins or threads and does not show agent replies in the review shell. Humans
follow agent progress in their agent session; while the review remains ready,
an edit to the original selected entry or a tracked linked resource refreshes
its iframe automatically so the human can inspect the fix and send another
batch.

## Consequences

- Raw bytes, URLs, origin isolation, root confinement, and browser-neutral
  serving retain their existing contract.
- Agents have an observable wake path: a foreground command completes with
  durable structured feedback.
- The extra shell/content boundary preserves authored same-origin behavior more
  closely than an opaque-origin iframe while keeping comment text out of the
  authored page's realm.
- Review rendering still differs from raw rendering because it is framed,
  sandboxed, instrumented, and unable to install a content-origin service
  worker. Those differences are explicit product output and release-test
  subjects.
- The probe removes the navigation-capability query from `location` before
  authored scripts run, but browser Navigation Timing may retain the original
  network URL. The capability is already consumed and cannot be replayed.
- Durable drafts and cursor acknowledgement add bounded private state and
  lifecycle transitions that the supervisor must serialize and recover.
- Automatic refresh adds a scoped entry-and-served-resource observer and
  trusted-shell notification mechanism. They must coalesce writes, confirm
  revisions through authorized reads, close with the review lifecycle, and
  never become a whole-grant watcher or raw live-reload mechanism.
- Release evidence must compare the raw HTTP contract before and after review
  creation and exercise the shell/content boundary, CSP failure, hostile page
  scripts, durable queue, cursor retry, interruption, and package lifecycle in
  real browsers and adversarial integration tests.
- A malicious authored page can misrepresent its target context or otherwise
  interfere with its own rendered content. The raw URL and an isolated browser
  profile remain the correct tools for untrusted-content inspection.

## Rejected alternatives

- **Instrument the raw URL.** This breaks the byte-faithful invariant and makes
  the meaning of `session.url` depend on caller intent.
- **Inject or expose a reload client on the raw URL.** This changes raw page
  behavior and still cannot force arbitrary non-browser consumers to refetch.
  Review owns its iframe refresh; external browser tools own any raw-page
  reload they need.
- **Use one shared instrumented origin.** Authored scripts would share browser
  authority with the comment editor and state API.
- **Make `serve` hang and emit feedback in logs.** This reverses its readiness
  and lifecycle contract, mixes diagnostics with domain data, and cannot
  reliably resume every agent harness.
- **Keep drafts only in browser storage.** Browser or tab closure could discard
  human work before an agent observes it.
- **Destructively drain feedback on read.** A failed response could lose a
  comment; cursor acknowledgement permits safe retry.
- **Persist pins and discussion threads.** Reattachment, resolution, identity,
  and collaboration semantics are not needed for the first-release prompt
  handoff.
- **Include text-range anchoring in the first release.** Cross-node Range
  serialization, quote context, boundary paths, and interaction conflicts do
  not earn their browser and schema complexity before element feedback is
  proven. Text-range feedback can be added without changing the raw/review
  separation.
