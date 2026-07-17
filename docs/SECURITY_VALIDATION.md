# Security validation evidence

This matrix maps the required checks in [THREAT_MODEL.md](THREAT_MODEL.md) to
repeatable evidence. `pnpm run check` runs the automated macOS/current-platform
set; Linux package installation is the separate
`pnpm run validate:package:linux` release check. The first table is the
implemented raw-serving, native CLI, logging, annotation, and browser-review
baseline. Automatic selected-entry refresh is accepted but not yet implemented;
its required evidence is listed separately. The release commands still must
pass before `0.1.0`.

| Control or adversarial case                                             | Evidence                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loopback content, private Unix control socket, and no public bind       | Fixed addresses in `src/serving/listener.ts` and `src/supervisor/server.ts`; strict CLI unknown-flag tests                                        |
| Exact content and control `Host` validation                             | Forged, missing, wrong-port, case, trailing-dot, and duplicate-Host HTTP/control/review tests                                                     |
| Fresh, high-entropy session names                                       | `generateSessionHostname()` uses 128 random bits; lifecycle and browser-origin tests require distinct observed hostnames                          |
| No permissive CORS; foreign page cannot read content                    | response-header integration test and Playwright cross-origin fetch test                                                                           |
| Raw browser responses require cache revalidation                        | `Cache-Control: no-cache` assertions in HTTP integration and Playwright raw-handler checks                                                        |
| Entry/root disclosure, broad-root and state-beneath-root rejection      | `test/grant.vitest.ts`, current supervisor overlap test, raw HTTP tests, and complete browser fixture                                             |
| Plain/encoded traversal, malformed UTF-8, controls, separators, Unicode | generated single-decode and Unicode filename cases in `test/http.integration.vitest.ts`                                                           |
| Root containment and entry escape                                       | 500 generated containment shapes plus default/explicit grant tests                                                                                |
| Symlink escape and replacement during concurrent requests               | fixed escape and 80 concurrent swap/request cases in `test/http.integration.vitest.ts`                                                            |
| Read-only source behavior and no project-local state                    | project-clean detached E2E, fixture directory assertions, and external state-path tests                                                           |
| Private socket authorization and bounded bodies                         | `0700`/`0600`, wrong-Host, 65 KiB body, and non-portable socket-path tests                                                                        |
| Authoritative ownership and safe stale recovery                         | list/serve transient-health preservation, live foreign owner, killed-owner recovery, mismatch, and lock fencing                                   |
| Concurrent startup, sessions, crashes, and idempotent cleanup           | detached E2E plus supervisor concurrency, SIGKILL, SIGTERM, and stop no-op tests                                                                  |
| Header, connection, request, and shutdown bounds                        | server configuration plus oversized-body, FIFO, growing/large-file, held-request, and aborted-reader tests                                        |
| Cancellation and acquisition cleanup                                    | interruption tests for ownership, listener acquisition/readiness, transport/body reads, streams, and supervisor root scope                        |
| Finalizer failure isolation                                             | injected session-scope finalizer defect plus failure/interruption cleanup for files, listeners, control, and ownership                            |
| Browser cookies, storage, cache, and service-worker isolation           | five-case Playwright origin suite in `validation/browser-origin/`                                                                                 |
| Structured-output injection and shape preservation                      | official TOON v3.3 fixtures plus 500 generated hostile-value round trips through TOON and JSON                                                    |
| Effect CLI grammar and native/domain channel separation                 | `test/command.vitest.ts`, `test/app.vitest.ts`, and black-box metadata/syntax/log-level cases in `test-e2e/cli.test.mjs`                          |
| Browser-controller separation                                           | real CLI URL checks under `validation/interoperability/`; package contents reject `validation/` files                                             |
| Reproducible package version and lifecycle                              | clean-prefix pack/install/serve/reinstall/uninstall checks on the current platform and Node 22 Debian                                             |
| Bundle dependency, license, and map policy                              | exact Effect pins, build-time import/license-set checks, third-party notices, linked maps without embedded source content                         |
| Distribution size and process cost                                      | Clean-package measurements recorded in the repository Effect plan cover size, file count, cold commands, readiness, and RSS                       |
| State and serving grants are canonically disjoint                       | Equality, inverse nesting, symlink directions, descendant-root, and ordinary disjoint cases at service and supervisor seams                       |
| Foreground and detached diagnostics stay separate, private, and bounded | All-level channel tests, closed-event canaries, exact rotation limits, private modes, restart, cleanup, and overlap checks                        |
| Selected-entry instrumentation remains isolated and byte preserving     | Token-aware transform corpus, raw before/after integration comparison, and Playwright raw-byte comparison                                         |
| Annotation state and feedback are durable and bounded                   | Permission/schema/recovery/limit tests; atomic send/end/discard; cursor retry, cancellation, restart, and tombstones                              |
| Human browser feedback reaches the foreground agent                     | Playwright element/freeform queue, shell-only comment, send, explicit-discard End, listener closure, and CLI feedback flow                        |
| Review browser authorization is adversarially complete                  | Ambiguous authority/fetch headers, content-type/method/query variants, no-CORS, and browser capability tests                                      |
| Hostile authored content cannot read typed comments                     | Playwright shell API attempts, sandbox/frame-busting, stored XSS, forged targets, and service-worker rejection                                    |
| Instrumentation readiness cannot be forged or replayed                  | One-use probe URL/lease, same-origin nested-frame rejection, pristine-parent capture, synthetic events, redemption, replay, and forged navigation |
| Instrumentation failure remains explicit                                | Playwright CSP/encoding/markup limits, authenticated navigation/recovery, native controls, modes, and stale revisions                             |

## Required `0.1.0` evidence (pending)

| Pending control or adversarial case               | Required evidence                                                                                                                                                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit-only automatic review refresh                | A real-browser workflow edits the original entry without calling reload, observes the new rendered revision, sends another batch, and repeats                                                                                                      |
| Observer authorization, coalescing, and lifecycle | In-place writes, atomic replacement, unchanged-byte touches, rapid bursts, missing/unsupported transitions, interruption, stop, End, deletion, and shutdown                                                                                        |
| Trusted-shell notification boundary               | Exact authority plus same-origin/fetch-metadata enforcement, no CORS read, bounded delivery/reconnect behavior, multiple shell clients, disconnect cleanup, and content-frame attempts                                                             |
| Revision and annotation continuity                | Authorized byte confirmation, unavailable-without-revision status, unavailable→same-bytes re-enable without reload, stale-selection clearing, old-revision draft preservation, authenticated replacement readiness, and reconnect/restart behavior |
| Raw independence through automatic refresh        | Raw URL/body/header/cache/path/lifecycle comparison before and after observation plus proof that no raw script, route, or forced consumer reload is added                                                                                          |

After these rows pass, the complete release-command matrix recorded in the
repository implementation plan remains required before publication.

## Residual risks

The [Threat Model](THREAT_MODEL.md#residual-risks) is the single source for
accepted residual risk. This file records evidence and pending gates only.

## Resource bounds

- Content listeners accept at most 100 connections, 100 headers, and 100
  requests per socket. Header receipt is limited to 5 seconds, request receipt
  and socket inactivity to 30 seconds, and absolute socket/response lifetime
  to 5 minutes.
- The control listener accepts at most 25 connections, 50 headers, 100
  requests per socket, a 64 KiB request body, 5-second headers, and 10-second
  request/socket inactivity. Both ends bound responses at 1 MiB.
- The review registry and versioned private annotation snapshot retain at most
  128 live review records and 128 unexpired retry tombstones. The snapshot is
  limited to 8 MiB, each review to 768 KiB, and each review to 32 queued drafts
  and 32 unacknowledged events. Comments are limited to 4 KiB of UTF-8;
  selectors to 2 KiB, DOM paths to 4 KiB, normalized text to 512 bytes, and
  stored entry/root paths to 8 KiB. Content mutations reserve capacity beneath
  the hard byte ceilings for mandatory cursor, status, and lifecycle commits.
  Each review admits one selected-entry read/parse/transform at a time and
  rejects entries larger than 8 MiB before parsing.
  Each review-origin start/readiness sequence is bounded at 2 seconds, and the
  private two-origin client operation is bounded at 6 seconds.
- The automatic-refresh implementation must fix and test the maximum observer
  count, metadata/revision check cadence, quiet-window duration, reconnect
  policy, and notification request/subscription limits per ready review before
  this pending contract can move into the implemented table.
- Control shutdown gives admitted sockets 2 seconds before forcing them closed;
  the session-registry shutdown fence rejects any delayed serve mutation that
  resumes after cleanup begins.
- Ownership records are limited to 16 KiB. Ownership-lock acquisition waits at
  most 10 seconds while interleaving health probes, followed by at most 5
  seconds for supervisor readiness. Health uses three bounded 500 ms attempts;
  ordinary control calls and content readiness wait at most 2 seconds each. An
  empty supervisor exits after 30 seconds by default.
