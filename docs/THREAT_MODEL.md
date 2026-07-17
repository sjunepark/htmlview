# Threat Model

> **Status:** Raw-serving controls, Effect CLI grammar, diagnostic filtering and
> persistence, durable annotations, and existing review controls are
> implemented. Automatic selected-entry refresh and its adversarial evidence
> are the next slice; final release evidence remains in
> [Security validation](SECURITY_VALIDATION.md).

## Scope

`htmlview` exposes files beneath a caller-authorized directory root to a
browser over loopback. Its security job is to make that grant explicit,
confined, local, observable, and temporary. The raw surface preserves source
bytes. The optional review surface is explicitly instrumented and must remain
isolated from both the raw path and trusted annotation controls.

This model covers the Effect CLI boundary, foreground and detached diagnostic
logging, supervisor, state files, control channel, raw static HTTP service,
trusted review shell, instrumented-content origin, annotation store, and
feedback delivery. It also covers the accepted review-owned entry observer and
trusted-shell change notification without extending that mechanism to the raw
origin. It does not claim that rendered HTML is safe or that target metadata
reported by authored code is authentic.

## Assets

- Files outside the chosen serving root, which must remain inaccessible
- Files inside the chosen root, which may contain secrets despite being inside
  the disclosure boundary
- Canonical local paths, which may themselves be sensitive
- The private control socket and supervisor ownership state
- Private supervisor diagnostic files and their retention bounds
- Human annotation drafts, sent feedback, delivered/acknowledged cursor state,
  and the confidentiality and integrity of typed comments
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
- The review shell and its bundled assets are trusted. Instrumented authored
  content is not trusted with shell DOM, comment text, review mutations, or
  supervisor authority.
- Authored content can lie about which element was selected because its own
  frame emits target metadata. The MVP isolates comment confidentiality and
  control authority, but does not attest annotation anchors.
- Human comments and all source-derived target context are untrusted data when
  persisted, rendered, encoded, or consumed as an agent prompt. `htmlview` does
  not invoke an LLM or edit source automatically.
- Diagnostic logs are not an audit or feedback channel. Increasing
  `--log-level` may add allowlisted events but never permits domain content or
  attacker-controlled strings.
- Browser controllers are supplied separately and are outside this trust
  boundary.

## Boundaries

1. CLI input crosses from the caller into local path and command validation.
2. The CLI crosses a user-private Unix-domain control socket into the
   supervisor.
3. Browsers cross an unauthenticated, per-session raw HTTP origin.
4. A browser crosses into the trusted review-shell origin and then a different
   instrumented-content origin inside a sandboxed iframe.
5. Target context crosses from the content frame to the shell through a
   schema-validated `postMessage` boundary.
6. Shell requests cross exact-origin browser endpoints into bounded review
   state transitions; those endpoints do not expose supervisor control.
7. Raw and review-content handlers cross from URL paths into the granted local
   filesystem; the annotation store and supervisor log sink cross into separate
   private state.
8. The ready review's entry observer crosses from a filesystem change hint into
   an authorized revision check, then a bounded same-origin notification asks
   the trusted shell to reload its content iframe.
9. Authored page scripts cross from local content into the browser's network,
   storage, and credential environment.
10. Effect CLI's native text help, version, completion, and syntax diagnostics
    cross directly to terminal channels; domain results cross the separate
    TOON/JSON encoder boundary.

## Threats and required controls

- **LAN or public exposure.** Bind numeric loopback only. Version one has no
  wildcard or interface-selection flag.
- **DNS rebinding or forged `Host`.** Bind only to `127.0.0.1`. Issue fresh
  random special-use `.localhost` hostnames for every raw session and live
  review origin, and accept only each origin's exact host and port. Do not
  trust the bind address alone.
- **Session discovery.** Expose no HTTP session-list endpoint and never encode
  canonical filesystem paths into content URLs. Treat content ports as
  discoverable, not as secrets.
- **Cross-origin local reads.** Emit no permissive CORS headers. Use
  same-origin resource policy where it does not break authored same-origin
  assets. Keep every raw session, review shell, and instrumented-content
  surface on its assigned origin.
- **Unintended in-root disclosure.** Treat the root as the complete disclosure
  grant, never infer a directory broader than the entry's parent, and return
  the exact resolved root and grant meaning from `serve`. Do not imply that a
  dotfile or sensitive-filename denylist protects files inside the root. Reject
  roots equal to or broader than the user home. Reject canonical overlap between
  a serving root and private state in either direction, including a root chosen
  from inside the state tree.
- **Unauthorized supervisor control.** Keep control on a `0600` Unix-domain
  socket beneath a current-user-owned `0700` directory. Browsers cannot address
  it. Review HTTP routes may mutate only their addressed review and cannot
  create or stop raw sessions, list state, select a root, inspect health, or
  proxy control requests.
- **Review CSRF and cross-origin mutation.** Require the exact shell authority,
  exact shell `Origin`, expected method and content type, and compatible fetch
  metadata for every mutation. Reject absent or conflicting signals. Emit no
  permissive CORS. CORS, random route names, and review IDs are not sufficient
  authorization by themselves.
- **Comment exposure to authored code.** Put the editor, drafts, and state API
  on the trusted shell origin. Embed authored content from a different origin
  in a sandboxed iframe without shell DOM access, top navigation, or browser
  state API authority. Never send comment text into the content frame.
- **Forged or oversized frame messages.** Accept target messages only from the
  expected iframe window and exact content origin, validate a versioned bounded
  schema, and send no sensitive state into authored code. Treat target context
  as untrusted because authored scripts can forge it. Treat document readiness
  separately: issue one random probe URL per instrumented navigation, serve it
  once without caching, keep its separate lease out of HTML, DOM attributes,
  and shell-to-frame messages, run the parser-blocking probe before authored
  scripts, and have it capture the real parent and pristine messaging
  primitives. Accept readiness mode only from a trusted browser event sent by
  that captured parent, then require the shell to redeem the lease before
  activating the revision. Reject service-worker script requests on the fresh
  content origin, ordinary fetches of the probe, same-origin nested entry
  navigations, synthetic message events, stale leases, and replay.
- **Plain and encoded traversal.** Decode once, reject malformed encodings and
  forbidden separators, resolve the final target, and enforce canonical root
  containment.
- **Symlink escape.** Authorize the resolved target, not only the lexical path.
  Re-check safely when opening to limit check/use races.
- **State theft, rollback, or tampering.** Keep the control socket,
  owner-fenced lifetime lock, annotation store, and diagnostic logs in a
  user-private directory with restrictive permissions. Validate version,
  shape, bounds, IDs, cursor monotonicity, and record relationships after every
  state read. Commit durable domain state atomically and fail closed on
  corruption rather than using partial records. Logs are not replayed as state.
- **Source modification.** Open content read-only and never place state,
  generated files, or annotations under the serving root.
- **Unsafe or forged source-change refresh.** Scope observation to the fixed
  pathname represented by the ready review's public entry route, not the
  complete grant, its initial canonical target, or a path supplied by the
  browser. Treat watcher events and metadata differences as hints, reauthorize
  the path's current regular-file target, and distinguish availability state
  from content change. Missing, forbidden, or unreadable may produce a bounded
  unavailable notification without a revision; iframe reload requires a
  confirmed byte revision different from the last rendered bytes. Coalesce
  bursts and atomic replacement, bound retries and notification delivery, and
  close every observer and notification resource with its review scope. Never
  send canonical paths, source bytes, comments, or anchors in a notification,
  and expose no equivalent raw-origin route.
- **Feedback loss or implicit deletion.** Persist queue success before the
  browser reports it, convert drafts to sent events atomically, read events
  non-destructively, and advance acknowledgement only through an explicit
  cursor previously returned. Stop and crash paths do not discard pending
  data; deletion requires an explicit discard flag when data remains.
- **Stored markup, terminal, or prompt injection.** Render comments and target
  fields with text-only DOM operations, validate them on every boundary, and
  encode CLI results with conforming TOON/JSON libraries. Do not concatenate
  them into HTML, logs, shell commands, or an implicit LLM request. Preserve
  their meaning as visibly structured human feedback so the consuming agent
  can treat source-derived context as untrusted.
- **Instrumentation weakening fidelity or policy.** Keep all raw response code
  unchanged. Transform only the review entry, never weaken authored CSP, and
  only for an iframe document-navigation request; authored fetches receive
  ordinary granted bytes. Return a specific review limitation when encoding,
  policy, markup, or authenticated probe activation makes safe insertion
  unavailable. The review result identifies itself as `instrumented_review`;
  raw remains the fidelity reference.
- **Resource exhaustion.** Bound headers, request concurrency, request
  duration, file streaming resources, state size, startup waits, and idle
  lifetime. Bound entry-observation cadence, change coalescing, revision reads,
  notification requests/subscriptions, and reconnect behavior. Make waits and body reads
  cancellable, and scope listeners, observers, request fibers, files,
  ownership, and timers so interruption releases them.
- **Information disclosure, injection, or exhaustion through logs.** Route
  foreground Effect logs only to stderr. Write detached supervisor logs only as
  bounded, rotated JSONL beneath the excluded private state directory using
  `0700` directories and `0600` files. Allowlist timestamps, levels, fixed
  operation/span names, stable error codes, opaque internal IDs, durations, and
  bounded counts. Never log comments or prompt text, anchors or selectors,
  DOM/HTML excerpts, form values, headers, cookies, credentials, canonical/full
  paths, file content, raw protocol payloads, dependency error text, or
  attacker-controlled strings. Sanitize newlines and control characters in the
  fixed metadata that remains. Enforce the allowlist with a closed
  diagnostic-event type and a sink that refuses to serialize arbitrary
  messages, error objects, or annotation maps. Provide no browser route or
  public logs command. Logs never deliver feedback.
- **Stdout corruption or parser ambiguity.** Use pinned Effect CLI as the sole
  grammar and dispatcher; remove the custom parser instead of composing two
  interpretations. Keep Effect logs off stdout. Treat native text
  help/version/usage as a distinct boundary from TOON/JSON domain output, and
  do not claim that `--json` transforms native parser output.
- **Structured-output injection.** Encode result values with conforming TOON
  and JSON libraries. Never interpolate paths, error text, or source-derived
  strings into structured output. Test delimiters, newlines, controls, Unicode,
  and terminal escape characters in both formats.
- **Stale or hijacked supervisor.** Verify protocol, version, instance, and
  process identity through health. Retry transient failures without removing
  ownership; reclaim a refused stale socket only after acquiring the lifetime
  ownership lock held by every live supervisor.
- **Browser-state collision.** Cookies are shared across ports and exact origin
  reuse revives storage, caches, and service workers. Give every new session
  and each shell/content review origin a fresh random `.localhost` label with
  at least 128 bits of entropy. The supervisor does not intentionally reuse
  labels after their lifecycle stops. Accept a reused label only for an
  idempotent request to the same live lifecycle.
- **Bundled dependency drift.** Pin the prerelease Effect toolchain exactly.
  Bundle only the audited dependency set, keep every external import declared
  as a runtime dependency, ship the bundled licenses, exclude embedded source
  content, inspect unstable CLI/logger behavior, and rerun the audit and full
  release gate for every update.

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

The review iframe reduces the authority that authored code has over comments;
it does not make authored code safe. The page may interfere with its own
selection behavior, display deceptive content, refuse framing, or forge anchor
metadata. Humans should treat the visible page as untrusted when the artifact
is untrusted, and agents should corroborate important targets against the raw
URL and source.

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

The trusted review shell may use a strict product-owned CSP, deny framing, and
restrict connections and frames to the exact review authorities. The
instrumented-content response preserves authored policy. It does not add a CSP
exception for the selection probe; when existing policy prevents the probe,
review reports the limitation rather than weakening policy. Shell/content
headers and iframe sandboxing are release-tested because they intentionally
make review rendering differ from raw rendering.

## Required adversarial validation

The canonical matrix of implemented evidence and pending release checks is
[Security validation](SECURITY_VALIDATION.md). It covers confinement, hostile
protocol and browser input, ownership and interruption races, resource bounds,
origin isolation, structured output, Effect CLI/logging, raw/review fidelity,
durable feedback, and automatic selected-entry refresh. A required control is
not complete merely because it is described here.

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
- Instrumented content can forge selection metadata or prevent its probe from
  becoming ready. Origin separation and the one-use lease protect comments,
  mutation authority, and readiness from false activation; they do not protect
  the truth of an annotation anchor or guarantee that hostile content remains
  annotatable.
- A human comment or source-derived excerpt can contain instructions intended
  to influence the consuming agent. Structured labeling and no implicit LLM
  invocation preserve the boundary, but the agent still decides whether to act.
- Review rendering differs from raw rendering because of framing, sandboxing,
  event handling, and the inserted probe. The review URL is not a fidelity or
  end-to-end testing substitute.
- Automatic refresh observes ordinary filesystem state rather than an editor
  transaction. A quiet-window policy can coalesce partial writes but cannot
  make arbitrary multi-step edits atomic; a temporarily unsupported entry may
  therefore surface a review limitation until a later confirmed change.
- Annotation persistence increases the lifetime of sensitive human comments.
  User-only permissions and explicit deletion reduce exposure but do not
  protect against another process running as the same operating-system user.
- Private diagnostic files reveal bounded timing, operation, opaque-ID, and
  error-code metadata to another process running as the same user until
  rotation removes them. The MVP offers no audit-grade completeness or public
  log-management API.
- Effect v4 is a pinned prerelease dependency. Exact pins and bundled-package
  checks prevent silent drift, but each deliberate update still requires
  source/API inspection, audit, and the complete release validation matrix.
