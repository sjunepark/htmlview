# Security validation evidence

This matrix maps the required checks in [THREAT_MODEL.md](THREAT_MODEL.md) to
repeatable evidence. `npm run check` runs the automated macOS/current-platform
set; Linux package installation is the separate
`npm run validate:package:linux` release check.

| Control or adversarial case                                             | Evidence                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Numeric-loopback-only listeners and no public-bind option               | Fixed listener addresses in `src/serving/http.ts` and `src/supervisor/server.ts`; strict CLI unknown-flag tests |
| Exact content and control `Host` validation                             | `test/http.test.ts` forged-host cases and `test/supervisor.test.ts` authenticated control requests              |
| High-entropy, never-reused session names                                | `generateSessionHostname()` uses 128 random bits; lifecycle and browser-origin tests require distinct hostnames |
| No permissive CORS; foreign page cannot read content                    | response-header integration test and Playwright cross-origin fetch test                                         |
| Entry/root disclosure and in-root hidden files                          | `test/grant.test.ts`, raw HTTP hidden/unreferenced tests, and complete browser fixture                          |
| Plain/encoded traversal, malformed UTF-8, controls, separators, Unicode | generated single-decode and Unicode filename cases in `test/http.test.ts`                                       |
| Root containment and entry escape                                       | 500 generated containment shapes plus default/explicit grant tests                                              |
| Symlink escape before and during requests                               | fixed escape and 40-swap request tests in `test/http.test.ts`                                                   |
| Read-only source behavior and no project-local state                    | project-clean detached E2E, fixture directory assertions, and external state-path tests                         |
| Control authentication and bounded bodies                               | missing-token and 65 KiB rejection tests in `test/supervisor.test.ts`                                           |
| Private, atomic, bounded discovery state                                | `0700`/`0600`, 16 KiB rejection, stale/corrupt recovery, and owner-fenced startup-lock tests                    |
| Concurrent startup, sessions, crashes, and idempotent cleanup           | detached E2E plus supervisor concurrency, SIGKILL, SIGTERM, and stop no-op tests                                |
| Header, connection, request, and shutdown bounds                        | server configuration plus oversized-body, held-request, large-file, and aborted-reader tests                    |
| Browser cookies, storage, cache, and service-worker isolation           | five-case Playwright origin suite in `validation/browser-origin/`                                               |
| Structured-output injection and shape preservation                      | official TOON v3.3 fixtures plus 500 generated hostile-value round trips through TOON and JSON                  |
| Browser-controller separation                                           | real CLI URL checks under `validation/interoperability/`; package contents reject `validation/` files           |
| Reproducible package version and lifecycle                              | clean-prefix macOS/current-platform pack/install/serve/upgrade/uninstall and Node 22 Debian container checks    |

## Explicit residual risks

- Filesystem confinement uses canonical resolution, a read-only file handle,
  and device/inode rechecks. Node does not expose a portable `openat2`-style
  API on all supported platforms, so exotic filesystem replacement behavior
  beyond the tested symlink swaps remains a residual race. No observed test
  response has served outside bytes.
- Another process running as the same operating-system user can read the same
  files and private runtime credential; user-only permissions are not a
  privilege boundary within one account.
- Ephemeral-port exhaustion and operating-system-wide file-descriptor
  exhaustion cannot be made deterministic in the ordinary test suite. Spawn,
  state, HTTP-start, and readiness failures cross stable structured error
  boundaries, while raw dependency errors stay off stdout.
- Some non-browser Linux resolvers do not implement special-use
  `*.localhost` lookup. Browsers are covered directly. Plain HTTP clients can
  connect to `127.0.0.1` while sending the returned URL's exact Host authority,
  as demonstrated by the Linux package test.
- Resource bounds limit each listener and force shutdown of stalled control
  clients. Many simultaneous sessions can still consume one listener and file
  descriptor set each; version one relies on the authenticated local caller
  and operating-system limits rather than imposing an arbitrary global session
  cap.
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
  request/socket inactivity. The client accepts at most a 256 KiB response.
- Control shutdown gives admitted sockets 2 seconds before forcing them closed;
  the session-registry shutdown fence rejects any delayed serve mutation that
  resumes after cleanup begins.
- Discovery and startup-owner records are limited to 16 KiB. Supervisor startup
  waits at most 5 seconds, control calls 2 seconds, and content readiness 2
  seconds. An empty supervisor exits after 30 seconds by default.
