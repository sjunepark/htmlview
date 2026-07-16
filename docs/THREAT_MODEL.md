# Threat Model

## Scope

`htmlview` exposes files beneath a caller-authorized directory root to a
browser over loopback. Its security job is to make that grant explicit,
confined, local, observable, and temporary without modifying content in ways
that reduce rendering fidelity.

This model covers the CLI, supervisor, state files, control channel, and raw
static HTTP service. It does not claim that rendered HTML is safe.

## Assets

- Files outside the chosen serving root, which must remain inaccessible
- Files inside the chosen root, which may contain secrets despite being inside
  the disclosure boundary
- Canonical local paths, which may themselves be sensitive
- The private control socket and supervisor ownership state
- Availability of the user's machine and agent session
- Browser credentials, local-network access, and data reachable by page scripts

## Trust assumptions

- The user or their agent is authorized to disclose every permitted file under
  the selected root, not only the entry document and referenced assets.
- Other web pages, local processes, and local machine users are not trusted to
  control `htmlview` or enumerate served paths.
- Served HTML may be buggy or malicious. It can read other permitted files on
  its origin and contact remote services. Fidelity requires serving its scripts
  unchanged, so `htmlview` cannot make that content safe through sanitization.
- Browser controllers are supplied separately and are outside this trust
  boundary.

## Boundaries

1. CLI input crosses from the caller into local path and command validation.
2. The CLI crosses a user-private Unix-domain control socket into the supervisor.
3. Browsers cross an unauthenticated, per-session HTTP content origin.
4. The HTTP service crosses from URL paths into the local filesystem.
5. Authored page scripts cross from local content into the browser's network,
   storage, and credential environment.

## Threats and required controls

- **LAN or public exposure.** Bind numeric loopback only. Version one has no
  wildcard or interface-selection flag.
- **DNS rebinding or forged `Host`.** Bind only to `127.0.0.1`. Issue a fresh
  random special-use `.localhost` hostname per session and accept only its
  exact host and port. Do not trust the bind address alone.
- **Session discovery.** Expose no HTTP session-list endpoint and never encode
  canonical filesystem paths into content URLs. Treat content ports as
  discoverable, not as secrets.
- **Cross-origin local reads.** Emit no permissive CORS headers. Use
  same-origin resource policy where it does not break authored same-origin
  assets. Keep each session on a separate origin.
- **Unintended in-root disclosure.** Treat the root as the complete disclosure
  grant, never infer a directory broader than the entry's parent, and return
  the exact resolved root and grant meaning from `serve`. Do not imply that a
  dotfile or sensitive-filename denylist protects files inside the root. Reject
  roots equal to or broader than the user home and roots containing runtime
  state.
- **Unauthorized control or CSRF.** Keep control on a `0600` Unix-domain socket
  beneath a current-user-owned `0700` directory. Browsers cannot address it;
  do not expose a TCP control route or rely on CORS, `Origin`, or route secrecy.
- **Plain and encoded traversal.** Decode once, reject malformed encodings and
  forbidden separators, resolve the final target, and enforce canonical root
  containment.
- **Symlink escape.** Authorize the resolved target, not only the lexical path.
  Re-check safely when opening to limit check/use races.
- **State theft or tampering.** Keep the control socket and owner-fenced
  lifetime lock in a user-private directory with restrictive permissions.
- **Source modification.** Open content read-only and never place state,
  generated files, or annotations under the serving root.
- **Resource exhaustion.** Bound headers, request concurrency, request
  duration, file streaming resources, state size, startup waits, and idle
  lifetime. Make waits and body reads cancellable, and scope listeners,
  request fibers, files, ownership, and timers so interruption releases them.
- **Information in logs.** Keep normal output minimal; avoid logging control
  credentials and avoid canonical paths unless explicitly requested.
- **Structured-output injection.** Encode result values with conforming TOON
  and JSON libraries. Never interpolate paths, error text, or source-derived
  strings into structured output. Test delimiters, newlines, controls, Unicode,
  and terminal escape characters in both formats.
- **Stale or hijacked supervisor.** Verify protocol, version, instance, and
  process identity through health. Retry transient failures without removing
  ownership; reclaim a refused stale socket only after acquiring the lifetime
  ownership lock held by every live supervisor.
- **Browser-state collision.** Cookies are shared across ports and exact origin
  reuse revives storage, caches, and service workers. Give every new session a
  fresh random `.localhost` label with at least 128 bits of entropy. The
  supervisor does not intentionally reuse labels after sessions stop.
  Accept a reused label only for an idempotent request to the same live session.
- **Bundled dependency drift.** Pin the prerelease Effect toolchain exactly.
  Bundle only the audited dependency set, keep every external import declared
  as a runtime dependency, ship the bundled licenses, exclude embedded source
  content, and rerun the audit and full release gate for every update.

## Malicious-content risk

A page served faithfully can execute JavaScript, contact remote services, probe
resources reachable by the browser, read every permitted file under its serving
root, display deceptive UI, and use any browser credentials available to its
origin or profile. Serving it over HTTP does not remove those capabilities.

For content that is not trusted, callers should use an isolated artifact root
and a disposable browser profile without personal credentials, with network
access appropriate to the task. `htmlview` surfaces the selected root but must
not silently rewrite, disable, or sandbox the raw document; doing so would
violate its core contract.

## Response policy

The service should provide the browser protections that do not transform page
bodies or contradict normal static hosting:

- accurate `Content-Type` and `X-Content-Type-Options: nosniff`;
- `Cache-Control: no-cache` so stored raw files are revalidated after edits;
- no permissive CORS response;
- no directory listings;
- explicit rejection of unsupported methods; and
- conservative server-identification headers.

Headers that alter authored application behavior require fixture validation
before adoption. A strict content security policy must not be imposed on raw
content because it would change what the page can execute.

## Required adversarial validation

The implementation evidence and explicit residual notes for this list are
maintained in [Security validation evidence](SECURITY_VALIDATION.md).

- `..`, percent-encoded traversal, double encoding, mixed separators, NULs,
  malformed UTF-8, Unicode filenames, and platform-specific path forms
- Symlinks created before and during requests, including targets swapped around
  authorization time
- Malicious same-origin requests for unreferenced, hidden, and sensitive files
  inside the selected root, confirming the documented grant rather than a
  nonexistent filename denylist
- Forged `Host`, cross-origin `fetch`, form posts, and wrong-authority control
  calls over the private socket
- Concurrent first startup, malformed or occupied socket paths, stale sockets,
  version mismatch, and supervisor crashes
- Interruption during ownership acquisition, listener readiness, request body
  reads, streaming, and shutdown, including a finalizer that fails
- Very large files, slow readers, excessive connections, and aborted requests
- Files outside an explicit root and symlinks resolving to them
- Concurrent sessions and an unrelated loopback service setting overlapping
  cookies for the same numeric host
- Port reuse while a browser profile retains origin-keyed storage, cache
  entries, and a service worker from the prior session
- TOON and JSON fields containing delimiters, quotes, newlines, controls,
  Unicode, and terminal escape sequences

## Residual risks

- Another process running as the same operating-system user can generally read
  the same files and open the same private socket; `htmlview` is not a
  privilege boundary within one user account.
- The page and any same-origin script can read and exfiltrate permitted files
  inside the selected root. Confinement protects the boundary, not files within
  it.
- An unauthenticated content listener may be discovered by another local user
  or process while it is active. Origin protections prevent ordinary remote web
  pages from reading it, but content confidentiality from same-host principals
  is not guaranteed in version one.
- Fully eliminating symlink check/use races depends on filesystem primitives
  available in the selected runtime and operating system. The implementation
  must document any remaining gap.
- Browser isolation relies on user agents and HTTP clients honoring the
  special-use `.localhost` resolution contract. Supported clients are covered
  by release interoperability checks; unusual clients may require explicit
  hostname-to-loopback resolution.
- Browser execution of untrusted authored code remains dangerous by design and
  is mitigated operationally with an isolated browser environment.
- Effect v4 is a pinned prerelease dependency. Exact pins and bundled-package
  checks prevent silent drift, but each deliberate update still requires
  source/API inspection, audit, and the complete release validation matrix.
