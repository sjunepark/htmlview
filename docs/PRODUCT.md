# Product Requirements

## Problem

Agents frequently receive a path to an HTML artifact but browser controllers
handle local files inconsistently. Some reject `file://`; others require
browser-specific flags or preserve file-origin behavior that breaks
root-relative assets, modules, or fetches. Ad hoc local servers provide HTTP,
but every agent must rediscover how to choose and disclose a root, retain the
process, find the port, verify readiness, and clean up afterward.

`htmlview` makes that translation a reusable, predictable agent operation.

## Primary job

Given a local HTML entry file and directory root that the caller authorizes for
read disclosure, return a confined loopback HTTP URL that is already ready for
any separately supplied browser tool to inspect and interact with.

The product is browser-neutral. Documentation uses
[`agent-browser`](https://github.com/vercel-labs/agent-browser) as one
interoperability example, not as a runtime dependency or the reason the product
exists. Callers should use direct `file://` navigation when it already provides
the behavior and safety they need.

The primary caller is an agent executing shell commands. A human may also use
the CLI, but interactive prompts and human-only output are not part of the
contract.

## Core scenarios

1. **Single HTML artifact.** Serve `report.html` with CSS, JavaScript, images,
   fonts, and other relative assets next to it.
2. **Project-root assets.** Serve an entry below a larger explicit root so
   references such as `/assets/app.css` resolve as authored.
3. **Repeated inspection.** Return the same live session when an agent invokes
   the same entry/root pair again after editing files.
4. **Parallel projects.** Serve independent entries from multiple working
   directories without port selection or process-management work by the agent.
5. **Cleanup.** Let the agent identify and stop one or all sessions; also clean
   up abandoned runtime state automatically.

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
- Return the resolved root and grant meaning in a successful `serve` result.
- Return an HTTP URL using a unique special-use `.localhost` name after the
  numeric-loopback listener is ready.
- Give each session a fresh, never-reused automatically allocated origin and
  retain the entry's path relative to the chosen root in the returned URL.
- Serve the entry and permitted subresources without body transformation.
- Select correct content types, including JavaScript modules, CSS, JSON, SVG,
  images, media, and fonts.
- Reflect source-file changes on subsequent requests without restarting the
  session.
- Support simultaneous sessions without requiring caller-selected ports.

### Agent experience

- Follow the applicable [AXI](https://axi.md/) interface conventions detailed
  in the [CLI contract](CLI.md).
- Produce compact TOON on stdout by default and accept `--json` on every command
  for the same logical value as JSON.
- Keep default schemas minimal, include definitive collection counts and empty
  states, and provide contextual next commands only when they avoid discovery
  work.
- Send progress and diagnostics only to stderr.
- Never prompt; every action must be expressible with arguments and flags.
- Reject unknown commands, arguments, and flags.
- Treat repeated serve and stop requests as successful idempotent operations.
- With no arguments, identify the executable, describe the tool, show the total
  and current sessions, and include a few relevant next commands.
- Provide concise, complete `--help` for every command.

### Lifecycle

- Keep URLs alive after the initiating CLI process exits.
- Expose current sessions and their status.
- Recover automatically when recorded supervisor state is stale.
- Shut down after a bounded idle period when no sessions remain.
- Store runtime metadata outside served repositories.

### Safety

- Bind only to loopback.
- Authorize every file against a canonical session root.
- Make clear that same-origin page code can read every permitted file beneath
  the selected root, including hidden files.
- Authenticate control operations separately from public content routes.
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
- Annotation in version one

## Planned CLI behavior

The exact spelling is provisional until Milestone 0. The complete interface
contract is in the [CLI contract](CLI.md); the intended command surface is:

```sh
htmlview serve ./report.html
htmlview serve ./public/report.html --root .
htmlview serve ./report.html --json
htmlview
htmlview stop <session>
htmlview stop --all
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

## Success criteria

- A caller can navigate the returned URL with `agent-browser`. Compatibility
  with at least one other independently installed browser controller is a
  required release check.
- The browser receives the authored HTML and assets without injected markup or
  runtime code.
- The agent never has to choose a port, manage a background process, or infer
  whether the server is ready.
- Serving cannot expose resolved targets outside the chosen root, and the
  caller can see the full in-root disclosure grant in the result.
- Repeated use across projects leaves no project-local state or orphaned
  long-lived processes.

## Deferred product decisions

- Implementation language and package channel
- Supported operating-system versions beyond initial macOS and Linux targets
- Whether optional annotations eventually live here or in a companion project
- Whether usage evidence justifies an opt-in ambient agent-session integration
