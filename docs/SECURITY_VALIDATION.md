# Security validation evidence

This matrix maps the required checks in [THREAT_MODEL.md](THREAT_MODEL.md) to
repeatable evidence. `pnpm run check` runs the automated macOS/current-platform
set; Linux package installation is the separate
`pnpm run validate:package:linux` release check.

| Control or adversarial case                                             | Evidence                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Loopback content, private Unix control socket, and no public bind       | Fixed addresses in `src/serving/http.ts` and `src/supervisor/server.ts`; strict CLI unknown-flag tests                          |
| Exact content and control `Host` validation                             | `test/http.integration.vitest.ts` forged-host cases and `test/supervisor.integration.vitest.ts` private-socket control requests |
| High-entropy, never-reused session names                                | `generateSessionHostname()` uses 128 random bits; lifecycle and browser-origin tests require distinct hostnames                 |
| No permissive CORS; foreign page cannot read content                    | response-header integration test and Playwright cross-origin fetch test                                                         |
| Entry/root disclosure, broad-root rejection, and in-root hidden files   | `test/grant.vitest.ts`, supervisor state-overlap test, raw HTTP tests, and complete browser fixture                             |
| Plain/encoded traversal, malformed UTF-8, controls, separators, Unicode | generated single-decode and Unicode filename cases in `test/http.integration.vitest.ts`                                         |
| Root containment and entry escape                                       | 500 generated containment shapes plus default/explicit grant tests                                                              |
| Symlink escape and replacement during concurrent requests               | fixed escape and 80 concurrent swap/request cases in `test/http.integration.vitest.ts`                                          |
| Read-only source behavior and no project-local state                    | project-clean detached E2E, fixture directory assertions, and external state-path tests                                         |
| Private socket authorization and bounded bodies                         | `0700`/`0600`, wrong-Host, 65 KiB body, and non-portable socket-path tests                                                      |
| Authoritative ownership and safe stale recovery                         | list/serve transient-health preservation, live foreign owner, killed-owner recovery, mismatch, and lock fencing                 |
| Concurrent startup, sessions, crashes, and idempotent cleanup           | detached E2E plus supervisor concurrency, SIGKILL, SIGTERM, and stop no-op tests                                                |
| Header, connection, request, and shutdown bounds                        | server configuration plus oversized-body, FIFO, growing/large-file, held-request, and aborted-reader tests                      |
| Cancellation and acquisition cleanup                                    | interruption tests for ownership, listener acquisition/readiness, transport/body reads, streams, and supervisor root scope      |
| Finalizer failure isolation                                             | injected session-scope finalizer defect plus failure/interruption cleanup for files, listeners, control, and ownership          |
| Browser cookies, storage, cache, and service-worker isolation           | five-case Playwright origin suite in `validation/browser-origin/`                                                               |
| Structured-output injection and shape preservation                      | official TOON v3.3 fixtures plus 500 generated hostile-value round trips through TOON and JSON                                  |
| Browser-controller separation                                           | real CLI URL checks under `validation/interoperability/`; package contents reject `validation/` files                           |
| Reproducible package version and lifecycle                              | clean-prefix pack/install/serve/reinstall/uninstall checks on the current platform and Node 22 Debian                           |
| Bundle dependency, license, and map policy                              | exact Effect pins, build-time import/license-set checks, third-party notices, linked maps without embedded source content       |
| Distribution size and process cost                                      | Phase 9 installed-artifact comparison records packed/install size, file counts, cold commands, readiness, and empty-daemon RSS  |

## Explicit residual risks

- Filesystem confinement uses canonical resolution, a read-only file handle,
  and device/inode rechecks. Node does not expose a portable `openat2`-style
  API on all supported platforms, so exotic filesystem replacement behavior
  beyond the tested symlink swaps remains a residual race. No observed test
  response has served outside bytes.
- Another process running as the same operating-system user can read the same
  files and open the private control socket; user-only permissions are not a
  privilege boundary within one account.
- The portable lifetime lock detects a live owner by PID. Rare PID reuse after
  a crash can therefore preserve stale authority and fail commands explicitly
  instead of risking an overlapping supervisor. After confirming the recorded
  PID belongs to an unrelated process, remove the inactive runtime directory
  as described in `docs/INSTALL.md`.
- Ephemeral-port exhaustion and operating-system-wide file-descriptor
  exhaustion cannot be made deterministic in the ordinary test suite. Spawn,
  state, HTTP-start, and readiness failures cross stable structured error
  boundaries, while raw dependency errors stay off stdout.
- Some non-browser Linux resolvers do not implement special-use
  `*.localhost` lookup. Browsers are covered directly. Plain HTTP clients can
  connect to `127.0.0.1` while sending the returned URL's exact Host authority,
  as demonstrated by the Linux package test.
- Each supervisor permits at most 32 sessions. Every session still consumes a
  listener and file-descriptor set, so operating-system exhaustion below that
  cap remains possible on an already constrained machine.
- The Effect runtime increases the installed artifact and empty-supervisor
  memory compared with the Promise baseline. Release measurements quantify
  that cost; the package remains two self-contained executables with only TOON
  and MIME lookup installed as runtime dependencies.
- Faithfully rendered HTML can read all files in its granted root, contact the
  network, and access capabilities of its browser profile. Isolated roots and
  disposable browser profiles remain operational requirements for untrusted
  content.

## Resource bounds

- Content listeners accept at most 100 connections, 100 headers, and 100
  requests per socket. Header receipt is limited to 5 seconds, request receipt
  and socket inactivity to 30 seconds, and absolute socket/response lifetime
  to 5 minutes.
- The control listener accepts at most 25 connections, 50 headers, 100
  requests per socket, a 64 KiB request body, 5-second headers, and 10-second
  request/socket inactivity. Both ends bound responses at 1 MiB.
- Control shutdown gives admitted sockets 2 seconds before forcing them closed;
  the session-registry shutdown fence rejects any delayed serve mutation that
  resumes after cleanup begins.
- Ownership records are limited to 16 KiB. Ownership-lock acquisition waits at
  most 10 seconds while interleaving health probes, followed by at most 5 seconds for supervisor readiness.
  Health uses three bounded 500 ms attempts; ordinary control calls and content
  readiness wait at most 2 seconds each. An empty supervisor exits after 30
  seconds by default.
