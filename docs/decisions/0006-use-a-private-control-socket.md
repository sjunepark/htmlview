# ADR 0006: Use a private Unix-domain control socket

- Status: Accepted
- Date: 2026-07-15
- Related: [ADR 0002](0002-per-user-loopback-supervisor.md),
  [ADR 0008](0008-separate-raw-serving-from-instrumented-review.md)

## Current applicability

ADR 0008 adds live review listeners to `stop --all`; durable review records are
not content sessions and are not discarded by supervisor shutdown.

## Context

The detached supervisor needs one authoritative per-user control endpoint.
The original loopback TCP design persisted a random port and bearer token in a
regular discovery file. A serving root containing that file could disclose the
credential. A failed health request also could not distinguish transient
unavailability from supervisor death, so deleting discovery could orphan live
sessions and permit a replacement supervisor.

Version one supports macOS and Linux, both of which provide Unix-domain
sockets with filesystem ownership and permissions.

## Decision

Use one deterministic `control.sock` beneath htmlview's `0700` per-user runtime
directory. The socket is `0600`; HTTP supplies bounded message framing over the
socket, but browsers cannot address it and no bearer credential is persisted.
A fixed Host value validates the protocol shape rather than acting as a
secret.

The lifetime lock is the authoritative supervisor ownership seam; the fixed
socket path is its control endpoint. The client
uses bounded health retries and distinguishes absence or connection refusal
from timeouts, resets, malformed responses, and other transient failures. It
never removes the socket or starts a replacement after transient failure.
An owner-fenced inter-process lock is held for the full supervisor lifetime.
It serializes startup and permits stale-socket removal only after the endpoint
refuses connections and the prior process no longer owns the lock.

Health reports the control-protocol identifier, package version, instance ID,
and PID. Normal operations require matching protocol and package versions.
`stop --all` may shut down a different package version when its control
protocol still matches, allowing a safe upgrade. It stops content sessions,
acknowledges the result, closes the control socket, and returns only after the
client observes the old instance gone.

There is no compatibility parser, manual fallback protocol, or downgrade path
inside the current executable. Normal version mismatches use
`supervisor.version_mismatch`. Protocol mismatches use
`supervisor.protocol_mismatch` for every operation, including shutdown, because
the current executable cannot prove that another protocol's shutdown request is
safe. Recovery requires the installation that started the running supervisor.

Socket paths longer than the conservative common macOS/Linux limit are
rejected as `state.unavailable` rather than silently relocating authority.

## Consequences

- No servable regular file contains a control credential.
- A transiently unavailable supervisor remains the sole owner and commands
  fail explicitly instead of reporting a false empty state.
- Concurrent startup, graceful handoff, and crash recovery share the private
  lifetime lock, while normal discovery needs no separate locator file.
- Control authorization is an operating-system user boundary, not a boundary
  between processes running as the same user.
- Windows is not supported by this version-one design.

## Rejected alternatives

- **Persisted TCP bearer discovery.** It creates a servable secret and splits
  endpoint discovery from lifetime ownership.
- **Delete state after any failed health request.** Temporary saturation and
  process death are not equivalent.
- **Reject only roots containing the discovery file.** This retains the more
  complex credential protocol and does not solve false-stale replacement.
- **Linux abstract sockets.** They avoid stale filesystem entries but are not
  portable to the supported macOS target.
