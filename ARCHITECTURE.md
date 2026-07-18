# Architecture

## Status and boundary

The raw-serving core, per-user supervisor, Effect execution model, Effect CLI,
foreground/private diagnostic sinks, review lifecycle, trusted browser review
surface, authenticated probe-readiness boundary, and bounded automatic review
refresh are implemented. Packaging and the final release matrix remain. The repository
[implementation plan](https://github.com/sjunepark/htmlview/blob/main/PLAN.md)
owns their sequencing.

`htmlview` converts a local HTML entry and an explicitly granted directory into
a ready loopback HTTP URL. The core owns grant validation, byte-faithful static
serving, lifecycle, private state, and an agent-facing CLI. Browser installation,
automation, visual interpretation, and source modification stay outside it.

The serving root is also the read-disclosure grant. Every permitted regular file
beneath it is available to same-origin authored code; filename denylisting does
not narrow that grant.

Review is a consumer of the same authorized-file boundary, not a mode of the raw
handler. It may instrument its own representation, but it cannot change the raw
URL, origin, path, response bytes, headers, or lifecycle. A review-owned entry
observer may ask its trusted shell to reload the instrumented iframe; it never
injects a reload client into raw content or controls arbitrary raw consumers.

## System map

```text
short-lived agent CLI
  |
  +-- command/domain result --> stdout: TOON or JSON
  +-- Effect diagnostic events --> stderr
  |
  +-- private Unix-domain control socket
        |
        v
  per-user supervisor --------> private state
        |                         ownership + annotation snapshot/logs
        |
        +-- raw-session registry --> raw listener --> raw browser origin
        |
        +-- review lifecycle
                +-- trusted shell origin
                +-- instrumented-content origin --> granted files
                +-- entry + served-resource observer --> shell iframe reload
                +-- durable feedback queue --> foreground agent wait
```

The annotation snapshot is the durable authority for review lifecycle records;
the supervisor retains only live scopes in memory. Browser tools consume
returned URLs and never become runtime dependencies.

## Implemented core

### CLI and domain boundary

`src/cli.ts` is the process-I/O and Node runtime boundary. `src/app.ts` defines
one pinned `effect/unstable/cli` command tree and dispatches typed handlers
through one `CommandService` Layer. Effect CLI owns native help, version,
completions, log-level selection, syntax diagnostics, and dispatch. Domain
handlers create ordinary JSON-compatible values, and `src/output.ts` alone
encodes TOON or JSON.

The CLI exits after an operation is confirmed. It does not stay attached to keep
a content URL alive. The no-argument path returns a state-oriented home value;
`serve` and `stop` are idempotent domain operations.

Native meta and syntax text stay outside the domain encoder. Foreground
diagnostics pass through the closed event seam in `src/diagnostics.ts`; its
logger accepts exactly one validated event and writes allowlisted JSON only to
stderr. Expected filesystem, control, supervisor, and listener failures use tagged
Effect error channels. `src/errors.ts` exhaustively maps them to stable public
codes. Unknown defects are sanitized at the executable boundary. The private
protocol validates requests and responses before domain code consumes them.

### Serving grant and static HTTP

`src/serving/grant.ts` canonicalizes the requested entry and root. Without
`--root`, it derives the grant from the supplied entry path's parent before
resolving the entry, so a symlink cannot silently broaden authority. The grant
must contain the resolved entry and be narrower than the user home. The runtime
rejects canonical trees that overlap private state in either direction.

Each raw session owns one listener bound to `127.0.0.1` and a fresh random
`h-<random>.localhost` authority. The entry URL retains its encoded path relative
to the root, preserving document-relative and root-relative resolution without a
session path prefix.

`src/serving/http.ts` validates the exact Host and method, decodes the URL path
once, and owns raw HTTP status, metadata, cache, MIME, and stream piping.
`src/serving/authorized-file.ts` canonicalizes and authorizes the final target,
rejects directories, fences the opened descriptor against path replacement
with device/inode checks, and exposes one scope-bound, size-limited stream. The
raw handler sends that stream without body transformation. Query strings do not
select files; URL fragments never reach the server.

`src/serving/listener.ts` owns the shared numeric-loopback listener resource,
request fibers, deadlines, and connection limits without owning route or
authority policy. Review creation uses it for separate fresh
`r-<random>.localhost` shell and `c-<random>.localhost` content authorities.
The shared surface is configured only after both listeners exist; readiness
stays unavailable until the grant, origins, and durable transition service are
installed.

The raw service has no filename or dotfile denylist and never opens a served
file for writing. Later file changes appear on reload without creating a new
session.

### Supervisor, control, and private state

`src/supervisor/server.ts` owns live session mutation, listener scopes, idle
shutdown, and graceful cleanup. `src/supervisor/client.ts` discovers or starts
that process, verifies its identity, and waits for requested readiness. One
operating-system user has at most one healthy supervisor.

Control uses HTTP framing over a deterministic Unix-domain socket beneath the
user-private state directory. Its containing directory is `0700`, the socket is
`0600`, and no bearer credential is persisted. A full-lifetime owner-fenced lock
serializes startup and stale-socket recovery. Transient health failure does not
authorize a replacement supervisor.

Every live raw session records its public entry route, canonical grant, listener
authority, lifecycle state, and bounded lifecycle metadata. A session ID is a
CLI locator, not a control credential. Runtime records never sit beneath a
served project.

### Effect execution and ownership

Effect owns fallible asynchronous execution, typed operational failures,
cancellation, schedules, and resource lifetime. Pure containment, header, and
result transformations remain ordinary TypeScript. Native Node filesystem,
HTTP, socket, stream, and process APIs remain narrow leaf adapters because their
exact security and byte behavior matters.

The implemented ownership shape is:

```text
supervisor root scope
  lifetime ownership lock
  control listener + admitted request fibers
  idle-shutdown fiber
  session registry
    session child scope
      content listener + request fibers
        request scope
          authorized file handle -> auto-closing stream
    stable review records and open-document index
      ready review child scope
        shell listener + request fibers
        instrumented-content listener + request fibers
```

Session creation commits only after listener readiness. Failed acquisition
closes its pending child scope. Stop, idle expiry, signals, and control shutdown
converge on one idempotent cleanup path that attempts every owned branch even if
one finalizer fails.

## Accepted `0.1.0` additions

### Detached diagnostic logging

The foreground CLI routes validated Effect diagnostic events only to stderr.
The detached supervisor writes the same allowlisted shape to at most three
64-KiB JSONL files beneath a private `0700` log directory; files are `0600` and
the threshold is fixed at info. Logs are neither feedback nor an audit/event
store. Both executable roots project causes before the Node runtime can print a
raw unhandled cause.

### Review service (implemented)

One open review attaches to a raw session's canonical-root/public-entry identity
and owns a stable review ID plus two fresh loopback origins:

- the trusted shell origin serves immutable product UI, owns the comment editor
  and browser mutations, and displays review content; and
- the instrumented-content origin reuses the serving grant, transforms only the
  selected entry, and serves ordinary granted assets unchanged.

The shell embeds review content in a cross-origin sandboxed iframe. Authored code
keeps an origin for its own assets, modules, and fetches but cannot read shell DOM
or typed comments. A schema-validated `postMessage` boundary carries bounded
target context and current geometry. The shell checks the source window and
exact origin.

Authored code cannot manufacture an accepted target message: messages must
carry the active probe lease and entry revision, and trusted pointer, keyboard,
or click events are the only probe inputs that select targets. Element metadata
is still explicitly untrusted because the authored page controls the DOM the
probe describes. The shell also mints a bounded one-use capability for the
exact selected-entry navigation. A clean cross-origin iframe request receives
raw bytes; malformed, expired, and replayed capability requests fail closed.
The parser-blocking probe removes the reserved query from the visible document
URL before authored scripts run. Each admitted navigation receives a one-use
random probe URL, and that URL
serves one uncached script containing a separate random lease, and the shell
must redeem the lease through its protected mutation API before a revision is
admitted. The parser-blocking probe is the document's first executable code and
captures the real parent window plus pristine message primitives before
authored code runs. Its readiness listener accepts only a trusted browser event
from that captured parent. The lease appears in neither HTML, DOM attributes,
nor shell-to-frame messages; stale/replayed leases fail closed, and
content-origin service-worker script requests are rejected so authored code
cannot intercept the probe response. Exact Host, Origin, method, content type,
and fetch-metadata checks protect browser mutations. Browser routes operate
only on their addressed review; raw-session creation, stop, listing, root
selection, and supervisor health remain private-socket operations.

The review entry transform inserts one external probe reference at the first
parser-created head position without parsing and reserializing the document.
Only the shell's cross-site iframe-navigation request for the selected entry
receives that transform; authored fetches and same-origin nested iframe loads
receive ordinary granted bytes and cannot disclose a probe lease. It never
weakens authored CSP.
Unsupported encoding, policy, framing, or markup produces an explicit review
limitation; the raw URL remains usable and annotation-only actions are disabled.
The shell tracks iframe document replacement: a shell-initiated selected-entry
reload recovers only after redeeming its new probe lease, while later
HTML-document navigation cannot replay an earlier lease and is reported as an explicit
unsupported-navigation limitation. Instrumentation covers the selected entry
and its live SPA DOM, not the navigated document.

### Annotation store and feedback delivery (implemented)

`src/annotation/model.ts` owns the strict versioned shape and whole-state
relationships. `src/annotation/store.ts` owns bounded no-follow reads, private
metadata checks, recovery of orphaned ready records, and durable atomic
replacement beneath the fixed private-state child. The store never derives a
write path from a grant and never opens a served file for writing.

Queueing creates a durable draft. Sending atomically converts selected drafts
into ordered immutable feedback events with stable IDs, bounded element context,
and the capture-time entry revision. Freeform events omit an anchor. Form values,
credential-bearing URLs, arbitrary data attributes, inline script/style, and
geometry are not durable feedback fields.

One agent consumer reads events non-destructively. A returned feedback cursor is
a delivered stream position; `--after` explicitly advances the separate
acknowledged cursor. Cancellation or response loss may cause duplicate delivery
but cannot acknowledge an unseen event. Browser End commits the final batch and
leaves it unacknowledged for the agent.

Listener stop never deletes drafts or unacknowledged events. Session stop first
persists every associated ready review as stopped, then closes all in-memory
review and raw scopes. Explicit deletion rejects pending data unless discard is
requested. Ended, fully acknowledged state retains only a bounded retry
tombstone. Live deletion persists a stopped barrier, closes its scope outside
the store mutation permit, then persists the tombstone; a failed phase is
retryable without a ready-but-closed state. Stopped, unended reviews may resume
for the same document identity with stable records and fresh browser origins;
ended reviews do not resume.

Interactive shutdown aborts before listener teardown when its stopped-state
write fails. Forced process shutdown instead closes every listener before
releasing control and ownership, then reports the persistence failure; startup
recovery converts any resulting orphaned `ready` record to `stopped`.

### Automatic review refresh (implemented)

A ready review owns one scoped observer for its fixed public entry pathname and
a bounded set of non-entry resources whose authorized GET bodies completed on
the review content origin. The HTTP handler reports the exact streamed byte
hash through a small observer interface. A pre-stream admission check excludes
the entry, oversized bodies, and resources beyond the tracking cap before any
observer hashing. Admission reserves capacity until successful completion or
abort, so concurrent requests cannot race past the cap; raw serving does not
use that seam. A confirmed entry revision starts a fresh resource generation:
the observer closes the prior watchers, releases their capacity, and ignores
late completions from the superseded document. Review-content assets use
`no-store` responses and bypass conditional validators so a confirmed byte
change cannot be hidden by stale browser cache state; raw cache behavior is
unchanged.
The observer watches only registered paths' parent directories and polls every
registered path as the authoritative fallback. It never recursively watches or
enumerates the grant.

Filesystem and metadata notifications are hints. The observer reauthorizes each
current regular-file target before publishing browser state and uses confirmed
byte hashes to suppress byte-identical writes. Entry availability remains
distinct from content revision. Linked resources contribute only an aggregate
hash, so canonical paths and bytes never cross the browser notification seam.
Resource count, size, watched-directory, inspection-concurrency, quiet-window,
and polling limits keep hostile fetch or filesystem activity bounded. Metadata
checks cover the registered set each second, while forced byte verification
rotates across at most one unchanged resource per poll instead of hashing the
whole set in one synchronized burst.

The trusted shell polls a bounded same-origin entry-state endpoint and
stages replacement content in a second isolated iframe. Durable drafts retain
their capture revisions. Resource refresh waits while feedback is dirty;
entry replacement clears transient selection, highlight, and unsaved element
context tied to the replaced DOM. The shell promotes the candidate and
discards the prior frame only after the new document completes the existing
one-use probe and lease handshake; failed candidates are discarded without
replacing the rendered document. Every
observer-driven navigation capability also carries the expected confirmed
revision. The content handler rejects different bytes before creating a probe
or recording a limitation derived from those mismatched bytes, and the shell
retries without confusing manual Explore navigation with automatic refresh.
Observed, pending, and rendered resource revisions are separate shell states.
A resource change arriving during staged navigation remains pending and starts
one coalesced follow-up after promotion or failure. Entry polling does not await
navigation acquisition, so a newer entry revision invalidates and supersedes an
older asset-only candidate.

If the fixed pathname is temporarily missing, forbidden, or unreadable, the
shell keeps the last successfully rendered iframe visible, shows an unavailable
state, and disables annotation. It does not navigate to an error response. An
authorized return to the same bytes re-enables annotation without reload; a new
revision reloads normally. Readable but unsupported bytes use the existing
explicit review-limitation flow.

The observer and notification resources belong to the ready review scope. A
shell polls in one of three phases: active, hidden/page-lifecycle paused, or terminal.
Local End enters terminal immediately; peer End, stop, deletion, and listener
shutdown enter it after a bounded failure budget. Terminal shells preserve the
last iframe read-only and never resume polling. Failed acquisition, shutdown,
and interruption likewise close server-owned resources without keeping
retained review state or an otherwise empty supervisor alive. Raw serving
remains passive: its next request reads current bytes, while an already-loaded
raw page or other consumer refreshes only under its own control.

## Runtime flows

### Serve and request (implemented)

1. Resolve and authorize the entry/root grant locally.
2. Discover or start the supervisor through the private ownership boundary.
3. Reject a broad grant or any canonical overlap with private state, then reuse
   or acquire a ready raw listener.
4. Return the session URL and exact grant as one domain result.
5. For each browser request, validate authority and method, authorize the opened
   target against the grant, and stream its original bytes.

### Review lifecycle (implemented)

1. The private v4 protocol snapshots an existing raw identity and lazily
   acquires or resumes its review listeners; it never accepts a root or entry.
   Both isolated origins pass readiness before an in-memory record commits.
   Live reuse retains origins; stopped resume retains the review ID and receives
   fresh origins. The public `review` command returns only after both are ready.
2. The shell displays instrumented review content. Element selection reports
   bounded untrusted context; the shell owns the editor and durable draft call.
3. Send commits ordered feedback events. Send & End also closes the review
   origins after committing the final response, without acknowledging delivery.
4. `feedback <review>` reads immediately or waits for new events. An optional
   `--after` first acknowledges a previously returned cursor.
5. The CLI emits one bounded result. Cancelling a waiter changes neither cursor
   nor stored event state.

### Edit-review loop (implemented)

1. A ready review observes its original selected entry and bounded authorized
   resources successfully served to its content origin outside the raw request
   path.
2. After an authorized read confirms a new entry or aggregate resource
   revision, the trusted shell is notified and reloads its content iframe.
3. The replacement entry is transformed and completes authenticated probe
   readiness. The shell then re-enables annotation with durable old-revision
   drafts intact and stale DOM selection state cleared.
4. The human sends another batch; the agent acknowledges the prior cursor,
   applies the next edit, and waits again. The raw URL and its consumers are not
   pushed or reloaded by this flow.

### Stop and recovery

Stopping a raw session closes its live review listeners before the raw listener
but preserves durable review records. `stop --all` closes every live listener,
then the private control socket; it does not discard annotation data. A later
feedback/delete operation may start a supervisor to load retained state. A
refused stale socket is reclaimed only under the lifetime ownership lock.

## Release invariants

1. **Raw file bodies are unmodified.** Successful raw GET bodies are the bytes
   of the safely opened source file; HEAD and conditional responses do not
   transform them.
2. **Browser tools stay external.** The runtime assumes no controller, profile,
   or debugging protocol.
3. **Browser-facing listeners are loopback-only.** `0.1.0` has no public-bind
   escape hatch.
4. **The root is the grant.** Every target stays beneath it; home/ancestor roots
   and any private-state overlap are rejected.
5. **No source mutation.** No command or browser workflow writes into the grant.
6. **Ready before output.** Successful serve/review results name accepting URLs.
7. **Domain results stay structured.** TOON is default, JSON is logically
   equivalent, native CLI text is separate, and logs never use stdout.
8. **Lifecycle is explicit and owned.** Sessions are observable, stoppable, and
   cleaned through scoped idempotent finalization.
9. **Control ownership is authoritative.** A transient socket failure cannot
   erase or replace its live owner.
10. **Review cannot weaken raw serving.** It adds separate origins and state only.
11. **Comments stay outside authored authority.** Target metadata remains
    untrusted; typed text and mutation routes stay shell-owned.
12. **Feedback loss requires explicit intent.** Reads are non-destructive and
    deletion of pending work requires acknowledgement or discard.
13. **Diagnostics are isolated and content-free.** They stay bounded/private and
    never carry feedback or untrusted content.
14. **Automatic refresh is review-only.** Entry observation may reload the
    trusted shell's iframe, but it cannot alter raw responses, add a raw
    notification route, or claim control of already-loaded raw consumers.

## State and concurrency

Supervisor lifecycle mutations are serialized. Session acquisition holds one
permit across reuse, capacity, listener readiness, and registry commit; static
file reads do not hold that registry-wide permit after a snapshot is authorized.
Each session and listener owns its request fibers so shutdown can interrupt and
release active work.

The supervisor admits at most 32 live raw sessions and retains at most 128
non-tombstone review summaries. Fresh random authorities are never intentionally
reused after a lifecycle ends, isolating cookies, storage, caches, and service
workers. Raw and review lifecycle mutations share one serialization boundary;
target review mutations are serialized per review, and at most one foreground
feedback wait is active for each review. The automatic-refresh slice adds at
most one bounded entry-and-served-resource observer per ready review and
bounded shell notification work. Exact resource, cadence, coalescing, request,
and terminal retry limits are recorded in Security Validation.

Exact body, connection, timer, and state limits are implementation constants in
[Security validation](docs/SECURITY_VALIDATION.md), not user-facing tuning
flags.

## Start-here code map

- `src/cli.ts`: executable entry and process-I/O boundary.
- `src/app.ts`: Effect CLI grammar, dispatch, and format-neutral result assembly.
- `src/diagnostics.ts`: closed diagnostic events and validated foreground sink.
- `src/service.ts`: command intent to grant/supervisor operations.
- `src/contracts.ts`, `src/errors.ts`, `src/output.ts`: domain values, tagged
  public failures, and the serialization boundary.
- `src/serving/grant.ts`, `src/serving/authorized-file.ts`: disclosure grant and
  scope-bound authorized reads.
- `src/serving/listener.ts`: scoped numeric-loopback listener mechanics.
- `src/serving/http.ts`: byte-faithful raw HTTP policy and response assembly.
- `src/serving/review.ts`: isolated review-origin routing, browser authorization,
  state projection, and durable mutation bridge.
- `src/serving/review-entry-observer.ts`: scoped entry and served-resource
  observation, authorization, byte-revision confirmation, coalescing, and
  availability state.
- `src/serving/instrumented-entry.ts`: byte-preserving selected-entry probe
  insertion and explicit instrumentation limitations.
- `src/serving/review-assets.ts`, `src/serving/review-browser-protocol.ts`:
  immutable trusted-shell/probe assets and strict browser request schemas.
- `src/supervisor/protocol.ts`: validated private wire contract.
- `src/supervisor/client.ts`, `src/supervisor/server.ts`: supervisor discovery,
  ownership, control, session registry, and cleanup.
- `src/supervisor/state.ts`, `src/supervisor/logging.ts`: private paths,
  records, lifetime lock, and bounded diagnostic persistence.
- `src/supervisor/supervisor-main.ts`: detached runtime, diagnostic layer, and
  sanitized process-failure boundary.
- `test/`: unit/integration tests with Vitest and `@effect/vitest`.
- `test-e2e/`: black-box executable and detached-process lifecycle tests.
- `validation/`: browser-origin, controller interoperability, build,
  documentation, and installed-package release evidence.
- `scripts/build.mjs`, `scripts/build-publication.mjs`: standalone bundles and
  atomic content-addressed artifact publication.

Do not add a generic browser-adapter or plugin layer without a current second
implementation. Add a nested review architecture document only after that
subsystem exists in code.

## Related documents

- [Documentation map](docs/README.md)
- [Domain language](CONTEXT.md)
- [CLI contract](docs/CLI.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Decision index](docs/decisions/README.md)
