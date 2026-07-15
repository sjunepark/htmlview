# Architecture

## Purpose and boundary

`htmlview` converts a local HTML entry and an explicitly granted directory root
into a byte-faithful loopback HTTP URL. An agent passes that URL to any
separately supplied browser controller. Documentation may use
[Browser Use](https://github.com/browser-use/browser-harness) as an example,
but no controller is privileged by the architecture.

The core owns local path validation, static HTTP serving, session lifecycle,
and an agent-facing CLI. It does not own browser installation, browser
automation, visual interpretation, or page modification.

“Byte-faithful” means the raw route serves selected files without rewriting or
injected runtime code. HTTP necessarily gives the content a web origin, so the
product intentionally does not reproduce `file://` origin semantics.

The selected root is both the HTTP origin root and the read-disclosure grant.
Every permitted file beneath it is available to same-origin page code; only
resolved targets outside it are forbidden.

## Target system shape

```text
agent
  |
  | CLI: home / serve / stop
  v
htmlview client
  |  \
  |   +-- result encoder --> stdout: TOON (default) / JSON
  |
  +-- private Unix control socket -----+
                                        |
                               per-user supervisor
                                        |
                             +----------+----------+
                             |                     |
                      session registry   per-session raw listeners
                                                   |
                                                   v
                                         loopback raw origins
                                                   |
                                                   v
                                    external browser controller

optional annotation surface (later) ---- consumes raw URL and emits feedback
```

The annotation surface is deliberately outside the core request path. No
plugin framework is planned; a concrete annotation workflow must first prove
that an additional interface is necessary.

## Components

### CLI client

Strictly validates command syntax, talks to the local supervisor, and creates a
minimal JSON-compatible result value. It encodes that value as TOON by default
or JSON with `--json`, then exits after the requested state is confirmed. It
does not need to remain attached to keep content available.

The command surface is intentionally small:

- `htmlview` lists active sessions.
- `htmlview serve <entry.html> [--root <directory>]` creates or reuses a
  session and returns its raw URL.
- `htmlview stop <session>` stops one session.
- `htmlview stop --all` stops all sessions and the supervisor.

With no command, the client renders a content-first home view containing its
executable identity, a definitive session count, minimal live session rows,
and contextual next commands. Structured errors use the selected data format;
progress and internal diagnostics use stderr. [`docs/CLI.md`](docs/CLI.md)
owns the complete public contract.

### Per-user supervisor

Owns one operating-system-user-private Unix-domain control socket and multiple
independent content sessions. Each content session gets an automatically allocated
loopback port and a fresh random name beneath `.localhost`, so its serving root
is also its HTTP origin root. This preserves authored root-relative URLs
without adding a session prefix to document paths.

The CLI discovers or starts the supervisor at a deterministic socket path and
waits until the requested content listener is ready before returning. Bounded
health retries preserve ownership when a live supervisor is temporarily
unavailable. Control requests use cancellable Effect adapters around the native
Unix-socket HTTP client; response bytes and JSON are bounded before shared
protocol schemas see a value.

The listener binds only to `127.0.0.1`; the unique hostname isolates cookies,
storage, caches, and service workers and is never reused after a session stops.
The supervisor owns concurrency, idle shutdown, stale-socket recovery, and
graceful termination. It must not require a project-local process manager.

### Session registry

Maps a session identifier to:

- the public entry route and canonical entry-file target;
- the canonical serving root;
- the dedicated content-listener address;
- lifecycle state; and
- timestamps needed for cleanup and diagnostics.

Runtime state belongs in the user's platform-appropriate state directory, not
in a served project. The control socket and lifetime ownership lock are private
to the user. A session identifier is not an authorization mechanism for control operations.
The canonical root in each record is the session's complete disclosure grant.

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
5. The supervisor rejects a root containing its runtime state, then atomically
   creates or reuses the session for the public entry route/canonical-root pair.
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

### Stop and recover

Stopping a missing or already stopped session succeeds as an idempotent no-op.
`stop --all` first closes every content listener, acknowledges the result, then
closes the supervisor; the client confirms that the old socket owner is gone.
An empty supervisor otherwise closes after a bounded idle period. A refused
stale socket is recovered only after acquiring the lifetime ownership lock.
That lock remains held until the old listener has fully closed, so transient
failures and graceful shutdown cannot trigger an overlapping replacement.

## Invariants

1. **Raw file bodies are unmodified.** A successful `200 GET` body is
   byte-for-byte the source file selected after safe path resolution. `HEAD`
   and conditional responses follow HTTP semantics without transforming it.
2. **Browser independence.** No core package depends on or assumes a particular
   browser controller, profile, or debugging protocol.
3. **Loopback only.** Version one has no LAN or public bind mode.
4. **The root is the grant.** A session may read permitted files beneath its
   canonical root and cannot read a resolved target outside it. No broader root
   is inferred; roots containing the home or runtime state are rejected.
5. **No source mutation.** Serving, listing, stopping, and future annotations
   never alter the served project.
6. **Ready before output.** A successful `serve` result means its URL already
   accepts requests.
7. **Structured agent contract.** Domain results are format-neutral. Stdout is
   TOON by default or logically equivalent JSON with `--json`; progress and
   internal diagnostics stay on stderr.
8. **Explicit lifecycle.** Sessions are observable and stoppable, and abandoned
   supervisors clean themselves up.
9. **Authoritative control ownership.** One lifetime lock fences the supervisor
   that owns the private socket. Transient control failure cannot erase or
   replace that owner.
10. **Optional layers cannot weaken the core.** A later review or annotation
    route may transform its own representation but cannot alter raw-route
    behavior or security checks.

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
semaphore keeps reuse, capacity, listener readiness, and registry commit atomic.
Each pending session owns a child scope that is closed on failed readiness,
targeted stop, or registry shutdown. Listing selects optional fields at the
control seam, keeping complete enumeration within the bounded response contract
without pagination.

The control listener and its request-fiber set share one scope. Control body
reads are cancellable and remove native listeners on completion, failure, or
interruption. Idle shutdown is a supervised Clock-driven fiber; each request or
session change invalidates an older expiry before the queued close rechecks the
current state. Shutdown rejects new mutations and attempts cleanup of idle work,
session scopes, control work, and lifetime ownership even when an earlier
finalizer fails.

Session mutations are serialized inside the supervisor. Static file reads do
not require registry-wide locking after a session snapshot has been validated.

Every session listener binds to `127.0.0.1` and issues a cryptographically
random `h-<random>.localhost` hostname. Exact host-and-port validation prevents
other localhost authorities from reaching content. Session labels are never
reused after stop; at least 128 random bits make accidental reuse negligible
without an unbounded tombstone registry. This isolates same-host cookies and
origin-keyed state from concurrent services and later port reuse.

## Start-here code map

- `src/cli.ts` is the executable entry and process-I/O boundary.
- `src/app.ts` dispatches parsed commands and builds format-neutral results.
- `src/command.ts` owns strict syntax, flag, field, and usage validation.
- `src/contracts.ts` owns JSON-compatible result and usage-error types.
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
  recovery.
- `src/service.ts` translates CLI intent into grant and supervisor operations.
- `test/` holds contract and TOON v3.3 conformance tests.
- `validation/browser-origin/` holds browser behavior evidence and remains
  outside the runtime.
- `validation/interoperability/` passes real CLI-returned URLs to independent
  browser controllers without adding them to the runtime.
- `validation/package/` verifies reproducible pack/install/reinstall/uninstall
  behavior on macOS/current platform and Node 22 Linux.

Avoid a generic plugin or browser-adapter layer without a current second
implementation.

## Related decisions

- [ADR 0001: Separate serving from browser control](docs/decisions/0001-separate-serving-from-browser-control.md)
- [ADR 0002: Use a per-user loopback supervisor](docs/decisions/0002-per-user-loopback-supervisor.md)
- [ADR 0003: Adopt an AXI output contract](docs/decisions/0003-adopt-an-axi-output-contract.md)
- [ADR 0004: Treat the serving root as a disclosure grant](docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md)
- [ADR 0005: Use Node.js, TypeScript, pnpm, and the npm registry](docs/decisions/0005-use-node-typescript-pnpm-and-the-npm-registry.md)
- [ADR 0006: Use a private Unix-domain control socket](docs/decisions/0006-use-a-private-control-socket.md)
- [Agent-facing CLI contract](docs/CLI.md)
- [Threat model](docs/THREAT_MODEL.md)
