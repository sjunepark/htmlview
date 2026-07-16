# Product Requirements

## Problem

Agents frequently receive a path to an HTML artifact but browser controllers
handle local files inconsistently. Some reject `file://`; others require
browser-specific flags or preserve file-origin behavior that breaks
root-relative assets, modules, or fetches. Ad hoc local servers provide HTTP,
but every agent must rediscover how to choose and disclose a root, retain the
process, find the port, verify readiness, and clean up afterward.

`htmlview` makes that translation a reusable, predictable agent operation and,
when requested, adds a separate instrumented surface for human feedback.

## Primary job

Given a local HTML entry file and directory root that the caller authorizes for
read disclosure, return a confined loopback HTTP URL that is already ready for
any separately supplied browser tool to inspect and interact with. When human
review is needed, attach a second, explicitly instrumented URL without changing
the raw URL or any served file, and deliver submitted comments to the agent as
durable structured feedback.

The product is browser-neutral. Documentation uses
[Browser Use](https://github.com/browser-use/browser-harness) as one
interoperability example, not as a runtime dependency or the reason the product
exists. Callers should use direct `file://` navigation when it already provides
the behavior and safety they need.

The primary caller is an agent executing shell commands. A human reviewer uses
the returned review URL but does not need to operate the CLI. CLI prompts and
human-only terminal output are not part of the contract.

## Core scenarios

1. **Single HTML artifact.** Serve `report.html` with CSS, JavaScript, images,
   fonts, and other relative assets next to it.
2. **Project-root assets.** Serve an entry below a larger explicit root so
   references such as `/assets/app.css` resolve as authored.
3. **Repeated inspection.** Return the same live session when an agent invokes
   the same public entry route/root pair again after editing files.
4. **Parallel projects.** Serve independent entries from multiple working
   directories without port selection or process-management work by the agent.
5. **Cleanup.** Let the agent identify and stop one or all sessions; also clean
   up abandoned runtime state automatically.
6. **Human review.** Give a human a separate URL where they can select an
   element or leave page-level feedback without modifying the raw
   representation.
7. **Agent handoff.** Let an agent wait for sent feedback as structured prompt
   data and acknowledge it with retry-safe cursor semantics.

## Version-one requirements

### Serving

- Accept one existing regular `.html` or `.htm` entry file.
- Treat the serving root as the complete read-disclosure grant for the raw
  origin.
- Define `serve <entry>` as an explicit grant of the entry's parent directory.
- Derive that parent before resolving the entry itself; reject an entry symlink
  whose target escapes it instead of broadening the default grant.
- Accept `--root <directory>` only as an explicit alternative grant containing
  the entry; never infer a broader project root.
- Reject a root equal to or broader than the user's home directory. Reject any
  canonical overlap between a root and htmlview's runtime state directory in
  either direction.
- Return the resolved root and grant meaning in a successful `serve` result.
- Return an HTTP URL using a unique special-use `.localhost` name after the
  numeric-loopback listener is ready.
- Give each session a fresh, high-entropy automatically allocated origin and
  do not intentionally reuse it after the session stops. Retain the entry's
  path relative to the chosen root in the returned URL.
- Serve the entry and permitted subresources without body transformation.
- Select correct content types, including JavaScript modules, CSS, JSON, SVG,
  images, media, and fonts.
- Reflect source-file changes on subsequent requests without restarting the
  session.
- Support simultaneous sessions without requiring caller-selected ports.

### Agent experience

- Follow the applicable [AXI](https://axi.md/) interface conventions detailed
  in the [CLI contract](CLI.md).
- Use pinned Effect CLI as the sole command parser, help generator, and
  dispatcher; do not keep a second compatibility parser.
- Produce compact TOON for domain results by default and accept `--json` on
  every domain command for the same logical value as JSON.
- Use Effect CLI's native text help, version, completions, log-level selection,
  and syntax diagnostics. `--json` does not transform this meta output, and
  syntax failures exit `1`.
- Keep default schemas minimal, include definitive collection counts and empty
  states, and provide contextual next commands only when they avoid discovery
  work.
- Send foreground progress and Effect logs only to stderr. Keep detached
  supervisor diagnostics in bounded, rotated, user-private files outside
  served roots; expose no public logs command.
- Never prompt; every action must be expressible with arguments and flags.
- Reject unknown commands, arguments, and flags.
- Treat repeated serve and stop requests as successful idempotent operations.
- With no arguments, identify the executable, describe the tool, show
  definitive raw-session and actionable-review counts and rows, and include a
  few relevant next commands.
- Provide generated, complete native `--help` for every command.

### Review and feedback

- Lazily create, reuse, or resume one open review for an existing raw session
  with `review <session>`; never open a browser automatically. Resume a
  stopped, unended review for the same canonical-root/public-entry identity
  with its stable ID, persisted drafts, and fresh origins.
- Return the separate review URL, associated raw URL, serving grant, and an
  explicit `instrumented_review` fidelity marker.
- Use a trusted review shell and a different instrumented-content origin. Both
  use fresh random `.localhost` authorities bound to loopback and neither adds
  routes to the raw origin.
- Start the page in annotation mode with an Explore/Annotate switch so native
  authored controls remain usable.
- Support bounded element-targeted and freeform comments. Capture the entry-byte
  revision and bounded target context, but never capture form values, inline
  script/style, credential-bearing URLs, or arbitrary `data-*` values.
- Persist queued drafts before reporting success in the browser. Sending
  atomically converts selected drafts into ordered immutable feedback events.
- Deliver sent feedback through `feedback <review>`, optionally waiting in the
  foreground. Logs are diagnostics, not a feedback transport.
- Use stable event IDs and a monotonic cursor for one agent consumer per
  review. Retrying may return a duplicate but must not lose unacknowledged
  feedback.
- Keep the first-release workflow one-way. Submitted comments do not remain as
  pins or discussion threads, and agents do not reply through the review page.
- Let a human send a final batch and end the review. Discarding unsent drafts
  requires explicit confirmation. Successful End closes both review origins
  after acknowledging the final batch and leaves the raw session live.

### Lifecycle

- Keep URLs alive after the initiating CLI process exits.
- Expose current sessions and their status.
- Coordinate one per-user supervisor through a private Unix-domain control
  socket and normally recover automatically when a crashed process leaves it
  stale; fail safely if operating-system PID reuse makes ownership ambiguous.
- Treat transient control unavailability as an error without discarding the
  live supervisor's ownership.
- Make `stop --all` close every session and the supervisor before succeeding.
- Shut down after a bounded idle period when no sessions remain.
- Closing a session also closes its live review listeners, but does not discard
  drafts or sent, unacknowledged feedback.
- Keep non-tombstone review IDs, statuses, and pending counts discoverable from
  the no-argument home result, including after listener or supervisor stop.
- Store runtime and annotation state outside served repositories. Delete
  pending review data only through an explicit discard operation.
- Keep detached diagnostic logs under the same excluded private-state
  boundary, with user-only permissions and explicit size/file-count bounds.

### Safety

- Bind only to loopback.
- Authorize every file against a canonical session root.
- Make clear that same-origin page code can read every permitted file beneath
  the selected root, including hidden files.
- Authorize control through a user-private local socket that browsers and other
  operating-system users cannot open.
- Limit browser-facing review routes to their addressed review data. They
  cannot create or stop raw sessions, list state, choose roots, or invoke other
  supervisor control operations.
- Treat authored review content, reported target metadata, comments, and stored
  records as untrusted at every browser, persistence, protocol, and output
  boundary.
- Never write comments, prompt text, anchors, selectors, DOM/HTML excerpts,
  form values, headers, cookies, credentials, full paths, file contents, raw
  protocol payloads, dependency error text, or attacker-controlled strings to
  diagnostic logs.
- Keep the comment editor and annotation state outside the authored page's
  origin. Authored scripts may forge target metadata in version one, but must
  not be able to read typed comments or call review mutation endpoints.
- Limit one supervisor to 32 concurrent sessions while allowing idempotent
  reuse at the limit.
- Do not mutate, upload, or publish served content.
- Make the trust implications of rendering untrusted HTML explicit.

## Non-goals

- Browser download, launch, profile management, CDP, WebDriver, or automation
- Visual assertions, DOM summaries, screenshots, accessibility audits, or page
  interpretation
- Building or bundling source applications
- Proxying an existing application server that already has an HTTP URL
- Emulating server-side routes, APIs, or SPA history fallback by default
- Reproducing `file://` origin behavior
- Replacing direct `file://` navigation when its semantics are already
  sufficient
- Remote sharing, LAN serving, tunneling, or collaboration
- HTML sanitization
- Persistent pins, resolved/unresolved threads, or reviewer identity
- Text-range selection or quote anchoring in `0.1.0`
- Agent replies in the review page or agent-to-human chat
- Automatic source edits, selector-to-source mapping, or built-in LLM calls
- Annotation across navigation to additional HTML documents

## CLI behavior

The complete interface contract is in the [CLI contract](CLI.md). The command
surface is:

```sh
htmlview serve ./report.html
htmlview serve --root . ./public/report.html
htmlview serve --json ./report.html
htmlview
htmlview review <session>
htmlview feedback --wait <review>
htmlview feedback --after <cursor> --wait <review>
htmlview review delete <review>
htmlview review delete --discard-feedback <review>
htmlview stop <session>
htmlview stop --all
htmlview --help
htmlview --version
htmlview --completions zsh
```

A successful serve result includes the selected root because it is a security
grant:

```toon
session:
  id: 7sp4k2
  status: ready
  url: "http://h-k7w4m2.localhost:49152/public/report.html"
grant:
  root: /workspace
  access: read_all_regular_files_beneath_root
```

The identifier and path shown above are illustrative. The session identifier
is for CLI operations; it is not embedded into content paths or treated as an
authorization credential.

`review` returns a different URL with `fidelity: instrumented_review`; it is
the shared human/agent annotation surface, not a replacement for the raw URL.
`feedback --wait` is the foreground wake-up operation: it emits progress only
to stderr and completes stdout once with a structured feedback batch.
Detached logs never act as feedback or prompt delivery.

## Success criteria

- A caller can navigate the returned URL with Browser Use. Compatibility
  with at least one other independently installed browser controller is a
  required release check.
- On the raw URL, the browser receives the authored HTML and assets without
  injected markup or runtime code.
- A human can submit element-targeted and freeform comments from the review URL,
  and an agent can receive them through the foreground feedback command after a
  browser or supervisor restart.
- Review creation leaves the raw URL, body bytes, headers, paths, origin, and
  lifecycle behavior unchanged.
- The agent never has to choose a port, manage a background process, or infer
  whether the server is ready.
- Serving cannot expose resolved targets outside the chosen root, and the
  caller can see the full in-root disclosure grant in the result.
- Repeated use across projects leaves no project-local state or orphaned
  long-lived processes.

## Deferred product decisions

- Supported operating-system versions beyond initial macOS and Linux targets
- Whether usage evidence justifies an opt-in ambient agent-session integration
- Whether demand justifies remote multi-user review or durable discussion
  threads
