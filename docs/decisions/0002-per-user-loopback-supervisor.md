# ADR 0002: Use a per-user loopback supervisor

- Status: Accepted
- Date: 2026-07-15

## Context

An agent needs the returned URL to remain available after a short CLI command
finishes. It should not have to choose ports, keep a shell job attached, parse
server logs for readiness, or remember how to terminate an arbitrary process.
Multiple projects may be inspected concurrently.

## Decision

Run one on-demand supervisor per operating-system user. It exposes an
operating-system-user-private Unix-domain control socket and manages multiple
sessions. Each session receives its own ephemeral content listener bound to
numeric loopback.

The returned URL retains the entry file's path relative to the selected root.
Because the session owns the whole content origin, document-relative and
root-relative references resolve naturally without rewriting HTML or prefixing
paths with a session identifier.

CLI invocations discover or start the supervisor at its deterministic private
socket and wait for confirmed readiness. The supervisor owns session
lifecycle, stale-socket recovery, and bounded idle shutdown.
[ADR 0006](0006-use-a-private-control-socket.md) records the control ownership
and failure semantics; control never depends on a
session identifier, port number, or content URL remaining secret.

Each new session receives a cryptographically random, never-reused hostname
under the special-use `.localhost` name and an ephemeral port, for example
`h-<random>.localhost:<port>`. The listener still binds only to `127.0.0.1`;
the hostname changes browser identity, not network exposure. The content
server accepts only its exact issued hostname and port. Internal readiness
checks use that same authority.

The supervisor never reissues a session hostname after that session stops.
Random labels carry at least 128 bits of entropy, so persistent tombstones are
not needed to make accidental reuse negligible. A repeated `serve` reuses the
same hostname only while the matching session is still live.

This replaces the provisional assumption that distinct numeric-loopback ports
were sufficient. Reproducible Chromium tests in
[`validation/browser-origin/origin.spec.mjs`](../../validation/browser-origin/origin.spec.mjs)
show that cookies cross ports on one numeric host and that exact origin reuse
revives local storage, cached responses, and a service worker. A fresh
`.localhost` label isolates all four even when the port is reused; a cookie
attempting `Domain=localhost` is rejected. The same fixture loads through both
Playwright and Browser Use. The complete fixture matrix is recorded in
[`docs/validation/browser-origin.md`](../validation/browser-origin.md).

## Consequences

- Agents receive ready URLs without managing background jobs or port conflicts.
- One lifecycle owner can list and clean up sessions across projects.
- Unique `.localhost` names isolate cookies as well as origin-keyed storage,
  caches, and service workers across concurrent and later sessions.
- Returned URLs use a special-use loopback hostname rather than a numeric host;
  compatibility with supported plain HTTP clients and browser controllers is a
  release gate.
- Startup requires careful locking, socket permissions, and stale-socket
  recovery.
- A supervisor failure temporarily affects all sessions, but the next CLI call
  can recover them from caller intent without modifying project files.

## Rejected alternatives

- **One foreground server per command.** The shell call cannot return while the
  URL remains alive unless the caller manages a background process.
- **One detached process per file.** This multiplies port allocation, discovery,
  cleanup, and orphan-process problems.
- **One fixed content port with path-prefixed sessions.** Session prefixes
  change document base paths and cannot preserve authored root-relative URLs
  without rewriting HTML.
- **One fixed port per session.** Caller-selected ports collide with unrelated
  processes; automatic ephemeral allocation removes that burden.
- **One numeric host with per-session ports.** Cookies ignore ports, and reused
  ports revive origin-keyed browser state.
- **Different `127/8` address per session.** Arbitrary addresses in the
  loopback block are not bindable on supported macOS without configuring
  interface aliases, which would require privileges and machine mutation.
