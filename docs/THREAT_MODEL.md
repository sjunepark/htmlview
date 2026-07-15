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
- The control credential and supervisor discovery state
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
2. The CLI crosses an authenticated local control channel into the supervisor.
3. Browsers cross an unauthenticated, per-session HTTP content origin.
4. The HTTP service crosses from URL paths into the local filesystem.
5. Authored page scripts cross from local content into the browser's network,
   storage, and credential environment.

## Threats and required controls

- **LAN or public exposure.** Bind numeric loopback only. Version one has no
  wildcard or interface-selection flag.
- **DNS rebinding or forged `Host`.** Accept only the exact loopback host and
  port forms issued by the service. Do not trust the bind address alone.
- **Session discovery.** Expose no HTTP session-list endpoint and never encode
  canonical filesystem paths into content URLs. Treat content ports as
  discoverable, not as secrets.
- **Cross-origin local reads.** Emit no permissive CORS headers. Use
  same-origin resource policy where it does not break authored same-origin
  assets. Keep each session on a separate origin.
- **Unintended in-root disclosure.** Treat the root as the complete disclosure
  grant, never infer a directory broader than the entry's parent, and return
  the exact resolved root and grant meaning from `serve`. Do not imply that a
  dotfile or sensitive-filename denylist protects files inside the root.
- **Unauthorized control or CSRF.** Require a separate high-entropy control
  credential on every mutation and sensitive query. Do not rely on HTTP
  method, CORS, `Origin`, or route secrecy alone.
- **Plain and encoded traversal.** Decode once, reject malformed encodings and
  forbidden separators, resolve the final target, and enforce canonical root
  containment.
- **Symlink escape.** Authorize the resolved target, not only the lexical path.
  Re-check safely when opening to limit check/use races.
- **State theft or tampering.** Store discovery state and credentials in a
  user-private directory with restrictive file permissions and atomic writes.
- **Source modification.** Open content read-only and never place state,
  generated files, or annotations under the serving root.
- **Resource exhaustion.** Bound headers, request concurrency, request
  duration, file streaming resources, state size, startup waits, and idle
  lifetime.
- **Information in logs.** Keep normal output minimal; avoid logging control
  credentials and avoid canonical paths unless explicitly requested.
- **Structured-output injection.** Encode result values with conforming TOON
  and JSON libraries. Never interpolate paths, error text, or source-derived
  strings into structured output. Test delimiters, newlines, controls, Unicode,
  and terminal escape characters in both formats.
- **Stale or hijacked supervisor.** Verify service identity through the
  authenticated health contract; recover stale records without killing an
  unrelated process.
- **Browser-state collision.** Cookies are shared across ports on the same host,
  so concurrent sessions and unrelated loopback services can exchange or
  overwrite them. Ephemeral-port reuse can also revive origin-keyed storage,
  caches, and service workers from a stopped session. Resolve both cases before
  release rather than treating a new port as complete isolation.

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
- no permissive CORS response;
- no directory listings;
- explicit rejection of unsupported methods; and
- conservative server-identification headers.

Headers that alter authored application behavior require fixture validation
before adoption. A strict content security policy must not be imposed on raw
content because it would change what the page can execute.

## Required adversarial validation

- `..`, percent-encoded traversal, double encoding, mixed separators, NULs,
  malformed UTF-8, Unicode filenames, and platform-specific path forms
- Symlinks created before and during requests, including targets swapped around
  authorization time
- Malicious same-origin requests for unreferenced, hidden, and sensitive files
  inside the selected root, confirming the documented grant rather than a
  nonexistent filename denylist
- Forged `Host`, cross-origin `fetch`, form posts, and unauthenticated control
  calls
- Concurrent first startup, corrupted state, stale PIDs, occupied ports, and
  supervisor crashes
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
  the same files and runtime credentials; `htmlview` is not a privilege
  boundary within one user account.
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
- Numeric loopback ports do not isolate same-host cookies and may be reused over
  time. The release cannot claim session-state isolation until the planned
  browser validation has produced and enforced a mitigation.
- Browser execution of untrusted authored code remains dangerous by design and
  is mitigated operationally with an isolated browser environment.
