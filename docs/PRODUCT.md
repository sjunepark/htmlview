# Product requirements

> **Status:** This is the accepted `0.1.0` target. Raw serving, Effect CLI,
> foreground/private diagnostics, annotation runtime, and automatic
> selected-entry refresh are implemented; release hardening remains. See
> [the repository plan](https://github.com/sjunepark/htmlview/blob/main/PLAN.md)
> for implementation status.

## Problem

Agents often receive a local HTML path, but browser controllers handle
`file://` inconsistently. Even an ad hoc HTTP server leaves every agent to
choose and disclose a root, manage a background process, discover its port,
verify readiness, and clean it up.

`htmlview` makes that operation predictable and browser-neutral. When human
review is needed, it adds a separate instrumented surface without weakening the
raw representation.

## Jobs and actors

The primary caller is an agent executing shell commands. Given an HTML entry
and an explicitly authorized directory, it needs a confined loopback HTTP URL
that is already ready for a separately supplied browser tool.

A human reviewer needs a different URL where they can select an element or
leave page-level feedback. The agent receives that work as durable structured
feedback. After the agent edits the original selected entry HTML, the review
updates automatically so the human can inspect the fix and continue the loop.
The human does not need the CLI, and the product never invokes an LLM or edits
source automatically.

Direct `file://` navigation remains preferable when its behavior and safety are
already sufficient.

## Core scenarios

1. Serve one HTML artifact with sibling CSS, JavaScript, images, fonts, and
   other relative assets.
2. Explicitly grant a broader root when authored root-relative assets require
   it.
3. Reuse the same live raw session after source files change.
4. Serve independent projects concurrently without caller-selected ports.
5. List and stop one or all sessions, with automatic abandoned-state cleanup.
6. Let a human submit element-targeted and freeform comments from a separate
   review surface without modifying the project.
7. Let one agent consumer wait for, retry, and explicitly acknowledge sent
   feedback without using logs as transport.
8. After that agent edits the original selected entry HTML, automatically
   refresh the ready review so the human can send another feedback batch.

## `0.1.0` requirements

### Raw serving

- Accept one existing regular `.html` or `.htm` entry.
- Treat the canonical serving root as the complete read-disclosure grant.
- Derive the default grant from the supplied entry path's parent before
  resolving the entry; reject an entry symlink that escapes it.
- Accept only an explicit `--root` as an alternative grant, and return the
  exact resolved root and grant meaning.
- Reject the user home, its ancestors, and any root canonically overlapping
  htmlview private state in either direction.
- Return a fresh high-entropy `.localhost` URL only after its numeric-loopback
  listener is ready.
- Preserve the entry route relative to the root, serve regular files without
  body transformation, use correct content types, and reflect later source
  changes without restarting.
- Support simultaneous sessions without caller-selected ports.

### Agent experience

- Follow the [CLI contract](CLI.md) as the authoritative command, result,
  channel, error, and exit specification.
- Use pinned Effect CLI as the only parser, help generator, completion source,
  and dispatcher.
- Emit compact TOON for domain results by default and logically equivalent JSON
  with `--json`; keep native text meta and syntax output separate.
- Keep schemas minimal, empty states definitive, unknown input rejected, and
  repeated serve/stop operations idempotent.
- Keep ordinary commands short-lived. The no-argument home view exposes
  actionable raw-session and retained-review state.
- Route foreground diagnostics to stderr and keep detached diagnostics bounded,
  private, and separate from feedback.

### Review and feedback

- Lazily create, reuse, or resume one open review for a live raw session without
  opening a browser. A stopped, unended review for the same document retains
  its ID and drafts but receives fresh browser origins; an ended review does
  not resume.
- Return the review URL, associated raw URL, grant, and explicit
  `instrumented_review` fidelity label.
- Use separate trusted-shell and instrumented-content origins. Neither adds a
  route to or changes the raw origin.
- Start in annotation mode and offer an Explore/Annotate switch so authored
  controls remain usable.
- Support bounded element-targeted and freeform comments. Capture a bounded
  element anchor and entry-byte revision without form values, inline
  script/style, credential-bearing URLs, or arbitrary `data-*` values.
- Persist drafts before reporting browser success. Sending atomically converts
  selected drafts into ordered immutable feedback events.
- Deliver events through the foreground `feedback` operation. One agent
  consumer uses stable event IDs and explicit cursor acknowledgement; retry may
  duplicate delivery but must not lose an unacknowledged event.
- Keep the workflow one-way: no persistent pins, discussion threads, or agent
  replies in the review page.
- While a review is ready, observe confirmed byte changes to its original
  selected entry and automatically reload only the instrumented review iframe.
  Coalesce rapid writes, preserve durable drafts with their capture revisions,
  clear selection state tied to the replaced DOM, and require the replacement
  document to complete authenticated probe readiness before annotation resumes.
- Keep change observation review-owned and bounded. It does not watch the whole
  serving grant, switch to a different output file, inject a client into raw
  HTML, or claim to refresh an already-loaded raw browser or other consumer.
- If the original entry pathname is temporarily missing, forbidden, or
  unreadable, keep the last rendered review visible, show that the entry is
  unavailable, and disable new annotation until authorized readable bytes
  return. Do not replace the review with an HTTP error page.
- Let a human send and end a final batch. End commits the batch and closes both
  review origins while leaving it unacknowledged for the agent; discarding
  unsent drafts requires explicit confirmation.

### Lifecycle and state

- Keep returned URLs alive after the initiating CLI exits.
- Coordinate one per-user supervisor through a private Unix-domain socket;
  preserve live ownership through transient control failure and recover stale
  state conservatively.
- Make `stop --all` close every live raw/review listener and the supervisor
  before succeeding. Stop never silently discards durable review data.
- Shut down the supervisor after a bounded idle period when no live sessions
  remain.
- Keep review IDs, status, and pending counts discoverable until their state no
  longer requires action.
- Persist annotations and bounded diagnostics in user-only private state,
  outside every serving grant and served repository.
- Require explicit discard before deleting drafts or sent, unacknowledged
  feedback. Retain only bounded retry tombstones after acknowledged deletion or
  completion.

### Safety

- Bind browser-facing listeners only to loopback and validate every exact Host.
- Resolve and authorize every file against the canonical serving grant,
  including symlink targets.
- Make clear that authored code can read every permitted in-root file and that
  rendering untrusted HTML remains dangerous.
- Keep supervisor control on the user-private socket. Browser review routes may
  mutate only their addressed review.
- Keep comment editing and mutation authority outside the authored content
  origin. Treat content-reported anchors as untrusted rather than authentic.
- Treat source-derived context, comments, persisted records, protocol values,
  and CLI values as untrusted at every boundary.
- Never mutate, upload, or publish served content.

The [Threat Model](THREAT_MODEL.md) owns required controls and residual risks;
[Security validation](SECURITY_VALIDATION.md) owns their evidence.

## Non-goals

- Browser download, launch, profiles, CDP, WebDriver, or automation
- Visual assertions, screenshots, accessibility audits, or page interpretation
- Building source applications or proxying an existing application server
- Server-side routes, APIs, or SPA history fallback
- Reproducing `file://` origin behavior
- Remote sharing, LAN serving, tunneling, accounts, or collaboration
- HTML sanitization
- Persistent pins, threads, reviewer identity, or source-control integration
- Text-range selection or quote anchoring in `0.1.0`
- Agent replies, chat, automatic source edits, selector-to-source mapping, or
  built-in LLM calls
- Annotation across navigation to additional HTML documents

## Success criteria

- A CLI-returned raw URL works with Browser Use and at least one independently
  supplied browser controller.
- Raw HTML and assets arrive without injected markup or runtime code.
- Review creation leaves the raw URL, bytes, headers, paths, origin, security,
  and lifecycle unchanged.
- Editing the original selected entry automatically refreshes a ready review
  without a manual browser reload; the raw URL serves the new bytes on its next
  request without gaining a push or injected reload mechanism.
- A human can send element-targeted and freeform feedback, and an agent can
  receive it after browser closure or supervisor restart without reading logs.
- The agent never chooses a port, manages a background process, or guesses
  readiness.
- Files outside the chosen grant cannot be served, and the grant is explicit in
  the result.
- Repeated use leaves no project-local state or orphaned long-lived process.

## Deferred decisions

- Supported operating-system versions beyond the initial macOS/Linux targets
- Opt-in ambient agent-session integration if usage evidence justifies it
- Remote multi-user review or durable discussion workflows
