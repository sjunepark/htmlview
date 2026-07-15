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
authenticated loopback control endpoint and manages multiple sessions. Each
session receives its own ephemeral numeric-loopback content listener.

The returned URL retains the entry file's path relative to the selected root.
Because the session owns the whole content origin, document-relative and
root-relative references resolve naturally without rewriting HTML or prefixing
paths with a session identifier.

CLI invocations discover or start the supervisor through private runtime state,
authenticate control requests, and wait for confirmed readiness. The
supervisor owns session lifecycle, stale-state recovery, and bounded idle
shutdown.

Control authorization uses a private credential and never depends on a session
identifier, port number, or content URL remaining secret.

Distinct ports create distinct web origins, but they do not isolate cookies:
cookies for one host are shared across all its ports, as described by
[RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5). An
ephemeral port may also be reused after a session stops. The release design
must validate and address both simultaneous and cross-lifetime browser state.

## Consequences

- Agents receive ready URLs without managing background jobs or port conflicts.
- One lifecycle owner can list and clean up sessions across projects.
- Separate content origins preserve root-relative paths and isolate
  origin-keyed storage and service workers between simultaneously active
  sessions, but same-host cookies remain shared across ports.
- Concurrent sessions and unrelated loopback services can exchange or overwrite
  cookies. Port reuse can additionally reintroduce storage, cache entries, or
  service workers from a prior session. Release validation must prevent or
  explicitly mitigate these behaviors through a follow-up decision.
- Startup requires careful locking, state permissions, and stale-record
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
