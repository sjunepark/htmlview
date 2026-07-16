# Architecture

## Purpose and boundary

The raw-serving architecture described here is implemented. The Effect CLI and
logging boundary from
[ADR 0009](docs/decisions/0009-adopt-effect-cli-and-logging.md) is the next
implementation slice. The review components are the accepted `0.1.0` target
from
[ADR 0008](docs/decisions/0008-separate-raw-serving-from-instrumented-review.md)
and follow that migration.

`htmlview` converts a local HTML entry and an explicitly granted directory root
into a byte-faithful loopback HTTP URL. An agent passes that URL to any
separately supplied browser controller. Documentation may use
[Browser Use](https://github.com/browser-use/browser-harness) as an example,
but no controller is privileged by the architecture.

The core owns local path validation, static HTTP serving, session lifecycle,
optional review lifecycle and persistence, and an agent-facing CLI. It does
not own browser installation, browser automation, visual interpretation, or
source-file modification.

“Byte-faithful” means the raw route serves selected files without rewriting or
injected runtime code. HTTP necessarily gives the content a web origin, so the
product intentionally does not reproduce `file://` origin semantics.

The selected root is both the HTTP origin root and the read-disclosure grant.
Every permitted file beneath it is available to same-origin page code; only
resolved targets outside it are forbidden.

Review is a consumer of that same grant, not a mode of the raw handler. Its
separately identified representation may instrument the selected entry while
the raw URL, origin, bytes, headers, paths, and lifecycle contract remain
unchanged.

## System shape

```text
agent CLI
  |  pinned Effect CLI: parse / help / completion / log level
  |  home / serve / review / feedback / stop
  |                         ^
  |                         | structured feedback + cursor
  v                         |
htmlview client ------------+
  |
  +-- result encoder --> stdout: TOON (default) / JSON
  +-- Effect logger ----> stderr
  |
  +-- private Unix control socket ------------------+
                                                     |
                                            per-user supervisor
                                                     |
                                      bounded private JSONL diagnostics
                                                     |
                        +----------------------------+-------------------+
                        |                            |                   |
                 session registry            review service     private store
                        |                            |
                 raw listener                 +-----+------+
                        |                     |            |
                  raw origin          trusted shell   instrumented content
                        |                     |            |
          agent/browser controller           +-- iframe --+
                                                     |
                                               human/browser
```

The review service is outside the raw request path and uses no generic plugin
or browser-adapter framework. Browser tools remain callers of returned URLs,
never runtime dependencies.

## Components

### CLI client

Pinned `effect/unstable/cli` is the sole command parser, generated-help owner,
validator, and dispatcher. A domain handler talks to the local supervisor and
creates a minimal JSON-compatible result value. It encodes that value as TOON
by default or JSON with `--json`, then exits after the requested state is
confirmed. It does not need to remain attached to keep content available.

Command orchestration is one Effect program over a single command-service
Layer. Effect CLI owns native text help, version, completions, log-level
selection, syntax diagnostics, and usage exit `1`. Domain successes and
expected tagged failures remain stable structured values; unexpected defects
are sanitized on domain stdout while allowlisted diagnostics stay on stderr.
The executable supplies the only Node runtime boundary and domain-output
newline. There is no compatibility parser or custom usage-error renderer.

The command surface is intentionally small:

- `htmlview` lists active sessions.
- `htmlview serve [--root <directory>] <entry.html>` creates or reuses a
  session and returns its raw URL.
- `htmlview review <session>` creates or reuses a live review and returns its
  separate instrumented URL plus the associated raw URL.
- `htmlview feedback [--wait] [--after <cursor>] <review>` reads or waits for
  sent feedback and advances acknowledgement explicitly.
- `htmlview review delete [--discard-feedback] <review>` removes retained
  review state without implicit data loss.
- `htmlview stop <session>` stops one session.
- `htmlview stop --all` stops all sessions and the supervisor.

With no command, the client renders a content-first home view containing its
executable identity, definitive raw-session and non-tombstone review counts,
minimal rows for both, and contextual next commands. Review summaries come
from bounded private state, so pending work remains discoverable after listener
or supervisor stop. Expected operational errors use the selected domain data
format. Native help/version/usage output remains Effect CLI text; foreground
progress and logs use stderr. [`docs/CLI.md`](docs/CLI.md) owns the complete
public contract.

### Per-user supervisor

Owns one operating-system-user-private Unix-domain control socket, multiple
independent raw sessions, and their optional reviews. Each raw session gets an
automatically allocated loopback port and a fresh random name beneath
`.localhost`, so its serving root is also its HTTP origin root. This preserves
authored root-relative URLs without adding a session prefix to document paths.

The CLI discovers or starts the supervisor at a deterministic socket path and
waits until the requested content listener is ready before returning. Bounded
health retries preserve ownership when a live supervisor is temporarily
unavailable. Control requests use cancellable Effect adapters around the native
Unix-socket HTTP client; response bytes and JSON are bounded before shared
protocol schemas see a value. Discovery, startup, ownership observation, and
shutdown confirmation use named Clock-driven schedules. The bootstrap lock is
scoped across discovery and readiness, while detached process setup is scoped
only until a successful unref handoff.

The listener binds only to `127.0.0.1`; the fresh, high-entropy hostname
isolates cookies, storage, caches, and service workers. The supervisor does not
intentionally reuse a hostname after its session stops.
The supervisor owns concurrency, review persistence, idle shutdown,
stale-socket recovery, and graceful termination. It must not require a
project-local process manager.
The supervisor executable also has one Node runtime boundary. Its scoped root
program awaits an explicit server-closed signal, so idle and control-request
shutdowns end the program while SIGINT or SIGTERM interrupt that same root and
run the idempotent shutdown finalizer before exit.

### Session registry

Maps a session identifier to:

- the public entry route;
- the canonical serving root;
- the dedicated content-listener address;
- lifecycle state; and
- timestamps needed for cleanup and diagnostics.

Runtime state belongs in the user's platform-appropriate state directory, not
in a served project. The control socket and lifetime ownership lock are private
to the user. A session identifier is not an authorization mechanism for
control operations. The canonical root in each record is the session's
complete disclosure grant.

### Static HTTP service

Each session listener maps URL paths directly to files under that session's
root. The returned entry URL uses the entry's encoded path relative to the
root. For example, `/workspace/public/report.html` under root `/workspace`
becomes `http://h-<random>.localhost:<port>/public/report.html`. This lets `./app.css`
resolve beside the entry and `/assets/logo.svg` resolve from the chosen root.

The service handles HTTP method validation, URL decoding, containment checks,
MIME types, conditional requests, and ordinary byte streaming.

The listener and its request-fiber set share one Effect scope. Each authorized
file handle belongs to its request scope until a successful `GET` transfers it
exactly once to the native auto-closing stream. Closing the listener scope
closes connections, interrupts remaining request work, and releases any handle
that was not transferred.

The service has no filename or dotfile denylist. Confinement prevents resolved
targets outside the root; it does not hide one in-root file from another page
on the same origin.

The raw service does not parse HTML in order to modify it. File changes become
visible on a later request or reload without requiring a new session.

### Review service (`0.1.0` target)

A live review surface attaches to one raw session but owns a separate
identifier, lifecycle, and two fresh loopback origins:

- the trusted shell origin serves immutable in-memory UI assets and owns the
  comment editor, draft list, send/end controls, and browser state API; and
- the instrumented-content origin reuses the session grant, serves ordinary
  assets without transformation, and transforms only the selected entry to
  load a bounded selection probe.

The shell embeds content in a cross-origin sandboxed iframe. The content keeps
an origin for its authored same-origin assets, modules, and fetches, but cannot
access the shell DOM or API. A schema-validated `postMessage` boundary carries
only target context and current geometry; the shell validates both source
window and exact origin. Authored code can forge target context from its own
frame, so target metadata is untrusted. It cannot read the shell's comment
editor or directly invoke shell mutation routes.

Review browser routes operate only on the addressed review. Exact Host,
Origin, and fetch-metadata checks protect mutations; no browser route exposes
raw-session creation or stop, listing, root selection, or supervisor health.
Review identifiers and random hostnames are locators and isolation tools, not
authorization credentials. Supervisor control stays on the private Unix
socket.

The entry transform inserts one external probe reference without parsing and
reserializing the document. It never weakens authored CSP or changes a raw
response. Unsupported encoding, policy, or markup yields an explicit review
limitation while leaving the raw URL usable. Instrumentation covers the
selected entry and its live SPA DOM only, not later HTML-document navigation.

### Annotation store (`0.1.0` target)

The annotation store owns versioned review records beneath htmlview's existing
user-private state directory. It validates every decoded record, bounds global
and per-review state, writes durable updates atomically with directory `0700`
and file `0600` permissions, and never opens a served file for writing.

Queueing creates a durable draft. Sending atomically replaces selected drafts
with ordered immutable feedback events containing stable IDs, bounded target
context, and the capture-time entry revision. One agent consumer reads events
non-destructively and acknowledges them with a monotonic cursor. An interrupted
read may be repeated; an event is not removed because a response merely began.

Review listener shutdown does not delete drafts or unacknowledged events.
Explicit deletion rejects pending data unless `--discard-feedback` is present.
Acknowledged ended reviews retain a small 24-hour tombstone for retry-safe
acknowledgement and deletion, then expire. Persistent pins, discussion threads,
and agent replies are not store concepts in `0.1.0`.

At supervisor startup, recovery validates every record and changes orphaned
`ready` reviews to `stopped` before answering a command; a browser authority is
live only when owned by the current process and scope.

The canonical-root/public-entry pair is the persistent document identity. A
stopped, unended review may attach to a newly live raw session for that same
identity, preserving its review ID and drafts while issuing fresh browser
origins. Ended reviews never resume. Non-tombstone review summaries are bounded
and exposed through the home query so retained data cannot become unreachable.

### Diagnostic logging (`0.1.0` target)

Effect Logger is the single effectful diagnostic interface. The foreground CLI
routes it exclusively to stderr and honors Effect CLI's native `--log-level`.
Normal successes and caller-correctable domain failures are not duplicated at
info; debug/trace detail is opt-in. The foreground level is not persisted or
passed to a newly detached supervisor.
The detached supervisor cannot inherit a usable terminal sink, so it writes
bounded, rotated JSONL at a fixed info threshold beneath htmlview's existing
private state directory.
Log directories use `0700`, files use `0600`, and root validation continues to
exclude the containing state tree from every serving grant. There is no browser
route, control operation, or public CLI command for reading logs in `0.1.0`.

Logging records decisions and health, not domain payloads. An allowlist admits
timestamps, levels, fixed operation/span names, stable error codes, opaque
internal identifiers, durations, and bounded counts. Comments or prompt text,
anchors and selectors, DOM/HTML excerpts, form values, headers, cookies,
credentials, full paths, file content, raw protocol payloads, dependency error
text, and other attacker-controlled strings are excluded. Exact rotation size
and retained-file count are implementation constants with restart, permission,
and redaction tests. Logs are never a feedback queue, event store, audit trail,
or prompt-delivery path.

A closed diagnostic-event type is the application logging seam. It accepts only
the allowlisted primitives above; application modules do not pass arbitrary
messages, error objects, or annotation maps directly to Effect Logger. The sink
validates that event shape and serializes only its approved keys, so an Effect
or dependency message cannot become JSONL accidentally. Both executable roots
project causes before `NodeRuntime` can print an unhandled raw cause.

## Effect execution and ownership

The service graph has two executable roots and one production service seam:

```text
cli NodeRuntime
  Effect CLI runner + stderr logger
    command handler
      CommandService Layer
        resolveServingGrant
        SupervisorClient
          state / ownership
          Unix control transport

supervisor NodeRuntime
  scoped runSupervisor + private rotating logger
    ownership + control + registries + annotation store
      startStaticServer per raw session
      startReviewServer per live review
```

Pure containment calculations, output assembly, and HTTP header logic remain
ordinary functions. Effect CLI owns command parsing and dispatch; Effect owns
fallible asynchronous execution, cancellation, typed operational failures,
schedules, logging, and resource lifetime. Native Node filesystem, HTTP,
socket, stream, and process APIs remain narrow leaf adapters because their
exact security and byte-stream behavior matters.

The logical ownership tree is closed from the leaves upward:

```text
supervisor root scope
  lifetime ownership lock
  control-listener scope
    control request fibers
  idle-shutdown fiber scope
  bounded diagnostic-log sink
  session-registry scope
    session child scope
      content listener + request-fiber set
        request scope
          authorized file handle -> native auto-closing stream
      review child scope (optional)
        shell/content listeners + request-fiber sets
        foreground feedback-wait fibers
  annotation-store handles (persistent data outlives listener scopes)
```

Session creation commits to the registry only after listener readiness. Failed
or interrupted acquisition closes the pending child scope. Stop, idle expiry,
signals, and control shutdown converge on the same idempotent cleanup path;
cleanup attempts every owned branch even when one finalizer fails.

## Error flow and test seams

Expected filesystem, state, content-listener, control, and supervisor failures
use tagged Effect error channels. The private protocol schemas validate both
requests and responses, and the supervisor sends only stable wire codes and
safe messages. `runApp` exhaustively projects expected failures to structured
domain stdout with exit code `1`. Effect CLI handles syntax before domain
execution, emits native text help and diagnostics, and exits `1`. Unknown
defects are sanitized as `runtime.internal` on domain stdout while only
allowlisted diagnostic detail reaches stderr or private supervisor logs.
Interruption is not converted into an operational error.

The `CommandService` Layer is the CLI orchestration seam. Supervisor tests use
the client constructor's process/lock adapters and `SupervisorOptions` for
native failure injection; raw and review server tests acquire listeners
directly in a scope. The annotation store and entry transformer expose narrow
deterministic seams. Vitest and `@effect/vitest` cover typed programs, scoped
finalization, state transitions, and deterministic `TestClock` policies. Real
Unix sockets and processes remain in integration and black-box E2E tests,
while Playwright, Browser Use, and clean installed-package workflows validate
only the public artifact.

## Runtime flows

### Serve an entry file

1. The CLI validates that the entry exists and is a regular HTML file.
2. For `serve <entry>`, it derives the candidate root from the supplied path's
   parent before resolving the entry. An exact `--root` is the only alternative
   grant.
3. It canonicalizes the candidate root and entry independently. An entry
   symlink whose target falls outside the canonical root is rejected before
   contacting the supervisor. Roots equal to or broader than the user home are
   rejected.
4. It discovers a healthy supervisor or starts one and waits for readiness.
5. The supervisor rejects any canonical overlap between the root and runtime
   state in either direction, then atomically creates or reuses the session for
   the public entry route/canonical-root pair.
6. The CLI returns the session state, raw URL, resolved root, and grant meaning
   as TOON or JSON, then exits.

Repeating the same request is a successful no-op that returns the existing
session. A different root is a different session because it changes
root-relative resource resolution and the authorized file set. Different
authorized routes to one symlink target are also distinct because they change
document-relative resolution.

### Serve a browser request

1. The session listener validates the `Host` and method.
2. It decodes the requested relative path exactly once.
3. It resolves the final filesystem target and verifies that it remains under
   the canonical session root, including through symlinks.
4. It rejects directory requests rather than inventing index or fallback
   behavior.
5. It fences the opened descriptor against path replacement by comparing
   device and inode metadata after open.
6. It streams the file with the correct content type and without body
   transformation. The request fiber remains alive until the native stream
   closes.

Query strings do not participate in filesystem lookup. URL fragments never
reach the server and remain available to the page.

### Create and use a review (`0.1.0` target)

1. `review <session>` asks the supervisor for the live raw-session snapshot and
   reuses its canonical grant. It never infers or accepts a new root.
2. The supervisor reuses an existing live review, resumes the stopped unended
   review for the same document identity with fresh origins, or allocates a new
   review ID, shell authority, content authority, and child scope. Ended
   reviews are never resumed.
3. Both listeners become ready before the review is committed and returned.
   The result includes the review URL, raw URL, grant, and
   `instrumented_review` fidelity marker.
4. The shell embeds the content entry. The content handler uses the shared
   authorized-file seam; ordinary assets are served unchanged and only the
   selected entry may receive the external probe reference.
5. In Annotate mode the probe reports a bounded element target. The shell owns
   the tooltip editor and persists a draft through its exact-origin browser
   API. Freeform drafts require no target.
6. Send atomically converts selected drafts to ordered feedback events. Send &
   End performs the same transition and then prevents new drafts. Ending with
   unsent drafts requires explicit browser confirmation before discard. After
   persisting and acknowledging the final response, End closes both review
   listener scopes but leaves the raw session live.

### Receive feedback (`0.1.0` target)

1. `feedback <review>` reads the validated persistent review record through
   the private control channel.
2. An optional `--after` cursor atomically acknowledges positions that were
   previously returned. A cursor beyond the highest returned position is
   rejected without state change.
3. Without `--wait`, the supervisor returns the current unacknowledged batch,
   including a definitive empty result. With `--wait`, one scoped waiter
   observes review state until feedback appears or the review ends/stops.
4. The CLI emits the bounded feedback batch and cursor once as TOON or JSON.
   Cancellation closes only the waiter; it does not acknowledge or delete an
   event.

### Stop and recover

Stopping a missing or already stopped session succeeds as an idempotent no-op.
Stopping a raw session first closes any live review listeners, then its raw
listener; persisted review data remains. `stop --all` closes every review and
raw listener, acknowledges the result, then closes the supervisor; the client
confirms that the old socket owner is gone. A later feedback/delete operation
may start a new supervisor and load retained review state. An empty supervisor
otherwise closes after a bounded idle period. A refused stale socket is
recovered only after acquiring the lifetime ownership lock. That lock remains
held until the old listener has fully closed, so transient failures and
graceful shutdown cannot trigger an overlapping replacement.

## Invariants

1. **Raw file bodies are unmodified.** A successful `200 GET` body is
   byte-for-byte the source file selected after safe path resolution. `HEAD`
   and conditional responses follow HTTP semantics without transforming it.
2. **Browser independence.** No core package depends on or assumes a particular
   browser controller, profile, or debugging protocol.
3. **Loopback only.** Version one has no LAN or public bind mode.
4. **The root is the grant.** A session may read permitted files beneath its
   canonical root and cannot read a resolved target outside it. No broader root
   is inferred; home/ancestor roots and any root canonically overlapping runtime
   state in either direction are rejected.
5. **No source mutation.** Serving, review, feedback, listing, and stopping
   never alter the served project or place state beneath its grant.
6. **Ready before output.** A successful `serve` or `review` result means its
   returned URL already accepts requests.
7. **Structured domain contract.** Domain results are format-neutral. Domain
   stdout is TOON by default or logically equivalent JSON with `--json`;
   Effect CLI owns native text meta/usage output, and foreground logs stay on
   stderr.
8. **Explicit lifecycle.** Sessions are observable and stoppable, and abandoned
   supervisors clean themselves up.
9. **Authoritative control ownership.** One lifetime lock fences the supervisor
   that owns the private socket. Transient control failure cannot erase or
   replace that owner.
10. **Review cannot weaken the core.** A review route may transform its own
    representation but cannot alter raw-route behavior, bytes, origin, or
    security checks.
11. **Comments stay outside authored authority.** The trusted shell owns
    comment editing and mutation APIs on an origin distinct from instrumented
    authored content. Target metadata remains untrusted.
12. **Feedback loss requires explicit intent.** Queueing is durable; reads are
    cursor-based and non-destructive; pending data is removed only by
    acknowledgement or explicit discard.
13. **Diagnostics are isolated and content-free.** Foreground logs use stderr;
    detached logs are bounded and private outside every grant. Neither carries
    feedback or untrusted domain content.

## State and concurrency

At most one healthy supervisor owns the deterministic per-user control socket.
Its directory is `0700` and the socket is `0600`; there is no persisted control
credential. An owner-fenced inter-process lock is held for the supervisor's
full lifetime; it serializes startup and confines stale-socket removal. Lock
acquisition and transfer are scoped Effect resources: 50 ms observation uses
`Schedule`/`Clock`, owner-record replacement and finalizer registration are one
uninterruptible transition, and release remains nonce-fenced. Health includes
protocol, version, instance, and process identity; mismatches are never replaced
silently. Content-listener host labels and ports belong to session state and are
never caller-selected. Each content listener owns a scoped request-fiber set;
listener shutdown closes active connections and interrupts any remaining
request work before the session scope is released.

The registry permits at most 32 live sessions. A FIFO single-permit Effect
semaphore keeps reuse, capacity, listener readiness, and registry commit
atomic. Each pending session owns a child scope that is closed on failed
readiness, targeted stop, or registry shutdown. A live review is a child of its
raw session for listener ownership, while its durable record is independent of
that child scope. Listing selects optional fields at the control seam, keeping
complete enumeration within the bounded response contract without pagination.

The control listener and its request-fiber set share one scope. Control body
reads are cancellable and remove native listeners on completion, failure, or
interruption. Idle shutdown is a supervised Clock-driven fiber; each request or
session change invalidates an older expiry before the queued close rechecks the
current state. Shutdown rejects new mutations and attempts cleanup of idle work,
session scopes, control work, and lifetime ownership even when an earlier
finalizer fails.

Session and live-review lifecycle mutations are serialized inside the
supervisor. Annotation transitions are serialized per review and durably
committed before waiters observe them. At most one foreground feedback wait is
active per review. Static file reads do not require registry-wide locking after
a session snapshot has been validated.

Every session listener binds to `127.0.0.1` and issues a cryptographically
random `h-<random>.localhost` hostname. Exact host-and-port validation prevents
other localhost authorities from reaching content. Session labels are never
reused after stop; at least 128 random bits make accidental reuse negligible
without an unbounded tombstone registry. This isolates same-host cookies and
origin-keyed state from concurrent services and later port reuse.

Every live review likewise owns fresh shell and content labels for exactly its
lifetime. Restarting the supervisor may restore durable review data, but does
not revive stopped browser authorities. State size, comments, drafts, events,
anchor fields, request bodies, connections, and waits have implementation
constants covered by contract and adversarial tests; `0.1.0` exposes no tuning
flags for them.

## Start-here code map

- `src/cli.ts` is the executable entry and process-I/O boundary. Phase 10 moves
  the pinned Effect CLI command tree and stderr logger composition to this
  boundary or a directly owned CLI module.
- `src/app.ts` currently dispatches parsed commands and builds format-neutral
  results; Phase 10 narrows it to domain command handling invoked by Effect
  CLI.
- `src/command.ts` is the current custom syntax/usage parser. ADR 0009 requires
  deleting it rather than wrapping it when Effect CLI becomes authoritative.
- `src/contracts.ts` owns JSON-compatible domain result types. Its current
  custom usage-error types leave with the parser.
- `src/errors.ts` owns tagged operational failures and their exhaustive safe
  public projection; unknown defects remain outside that union.
- `src/output.ts` is the only TOON/JSON encoding boundary.
- `src/version.ts` is the release version surfaced by the CLI and supervisor.
- `src/serving/grant.ts` validates and canonicalizes the entry/root disclosure
  grant.
- `src/serving/http.ts` owns the byte-faithful confined HTTP handler and
  per-session content listener.
- `src/supervisor/server.ts` owns private socket control, serialized session
  mutation, idle shutdown, and graceful cleanup.
- `src/supervisor/client.ts` discovers, verifies, starts, and calls the detached
  supervisor.
- `src/supervisor/protocol.ts` is the runtime-validated source of truth for
  control requests, responses, wire errors, identities, and session summaries.
- `src/supervisor/state.ts` owns private socket paths, bounded private records,
  and the scoped lifetime ownership lock that serializes startup and stale
  recovery. The supervisor diagnostic sink will use this same excluded state
  boundary without becoming supervisor protocol state.
- `src/service.ts` translates CLI intent into grant and supervisor operations.
- `test/` holds Vitest unit and integration coverage, including Effect scopes,
  clocks, schemas, native HTTP, and TOON v3.3 conformance.
- `test-e2e/` holds black-box executable and detached-process lifecycle tests.
- `scripts/build.mjs` creates and validates the two minified executable bundles
  and external source maps, rejecting undeclared imports and unlicensed bundled
  dependency drift.
- `scripts/build-publication.mjs` owns content-address verification, immutable
  generation installation, package-generation checks, and atomic activation
  through the stable `dist/cli.js` launcher. Its internal pre-activation seam
  gives deterministic fault and concurrency validation the same publication
  implementation as production.
- `validation/browser-origin/` holds browser behavior evidence and remains
  outside the runtime.
- `validation/interoperability/` passes real CLI-returned URLs to independent
  browser controllers without adding them to the runtime.
- `validation/package/` verifies reproducible pack/install/reinstall/uninstall
  behavior, exact package contents, and detached cleanup on macOS/current
  platform and Node 22 Linux.

Phase 10 first replaces the custom parser/help/dispatcher and adds the two log
sinks without changing domain services or raw HTTP leaves. The annotation
slices then extract a narrow authorized-file service from
`src/serving/http.ts`; both raw and review handlers will consume that service,
while raw response assembly remains owned by the existing handler. They will
then add a cohesive `src/review/` subsystem with separate modules for lifecycle
and domain transitions, private persistence, shell/content HTTP handling,
browser-message contracts, and the pure entry transform. Browser shell/probe
sources remain ordinary typed inputs bundled as immutable in-memory assets.
The subsystem exposes review operations to the supervisor rather than exposing
filesystem, socket, or store mechanics to the CLI.

Avoid a generic plugin or browser-adapter layer without a current second
implementation.

## Related decisions

- [ADR 0001: Separate serving from browser control](docs/decisions/0001-separate-serving-from-browser-control.md)
- [ADR 0002: Use a per-user loopback supervisor](docs/decisions/0002-per-user-loopback-supervisor.md)
- [ADR 0003: Adopt an AXI output contract](docs/decisions/0003-adopt-an-axi-output-contract.md)
- [ADR 0004: Treat the serving root as a disclosure grant](docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md)
- [ADR 0005: Use Node.js, TypeScript, pnpm, and the npm registry](docs/decisions/0005-use-node-typescript-pnpm-and-the-npm-registry.md)
- [ADR 0006: Use a private Unix-domain control socket](docs/decisions/0006-use-a-private-control-socket.md)
- [ADR 0007: Adopt Effect v4 as the execution model](docs/decisions/0007-adopt-effect-v4.md)
- [ADR 0008: Separate raw serving from instrumented review feedback](docs/decisions/0008-separate-raw-serving-from-instrumented-review.md)
- [ADR 0009: Adopt Effect CLI and Effect logging](docs/decisions/0009-adopt-effect-cli-and-logging.md)
- [Domain language](CONTEXT.md)
- [Agent-facing CLI contract](docs/CLI.md)
- [Threat model](docs/THREAT_MODEL.md)
