# Agent-facing CLI contract

## Purpose

`htmlview` is an Agent eXperience Interface (AXI): its primary caller is an
agent executing shell commands. The interface follows the applicable
principles from [axi.md](https://axi.md/): compact structured output,
definitive results, strict input handling, content-first discovery, and
actionable next commands.

The CLI exposes browser-neutral serving and review state. It does not launch,
configure, or depend on a browser controller.

## Command surface

The `0.1.0` command surface is:

```sh
htmlview [--fields <name,...>] [--json]
htmlview serve [--root <directory>] [--json] <entry.html>
htmlview review [--json] <session>
htmlview feedback [--wait] [--after <cursor>] [--json] <review>
htmlview review delete [--discard-feedback] [--json] <review>
htmlview stop [--json] <session>
htmlview stop --all [--json]
```

The pinned `effect/unstable/cli` API is the sole parser, help generator, and
dispatcher. It supplies these native global options:

- `--help`/`-h` for generated text help;
- `--version`/`-v` for text version output;
- `--completions <bash|zsh|fish|sh>` for shell-completion output; and
- `--log-level <all|trace|debug|info|warn|warning|error|fatal|none>` for the
  current foreground command.

`--json` is htmlview's global domain-output setting and does not transform
native help, version, completion, or usage output. The no-argument home command
accepts `--fields entry,root` to add those fields to each session row. Unknown
commands, arguments, flags, field names, and conflicting `stop` targets are
rejected; they are never ignored. `--fields` may be provided at most once.
Examples put options before positional arguments for readability; callers must
not depend on a bespoke option-ordering rule beyond what pinned Effect CLI
accepts.

Native help, version, and completions succeed without contacting the
supervisor. Help is the universal discovery path, not a domain operation. Do
not combine `--json` with a native meta option expecting structured output.

Commands never prompt. Repeating a successful `serve`, live `review`, or `stop`
request is a successful no-op. Review deletion is idempotent while its bounded
tombstone remains.

`serve` is non-blocking after readiness: the CLI process returns the structured
result, while the detached supervisor keeps the session URL alive. It does not
behave like a terminal-attached development server.

`feedback --wait` is the deliberate foreground exception. It waits for domain
feedback, writes only progress or heartbeats to stderr, and emits one final
structured stdout result when feedback is available or the review can no
longer accept it. Detached supervisor logs are never a feedback transport.

## Logical result model

Commands produce ordinary JSON-compatible values internally. The output
encoder is selected only at the stdout boundary:

- TOON is the compact default and initially targets the
  [TOON v3.3 specification](https://toonformat.dev/reference/spec.html).
- `--json` emits the same logical value as JSON.
- Both formats use the same field names, value meanings, operational error
  codes, and exit status.
- Contextual command strings may differ only to retain an explicit `--json`
  choice in the next command; the surrounding result schema and domain values
  remain equivalent.
- Contract tests decode both representations and compare their logical values.

The implementation uses `@toon-format/toon` 2.3.0 and validates it against all
official `@toon-format/spec` 3.3.0 fixtures rather than interpolate
paths, errors, or other untrusted values into either format. The selected TOON
implementation and conformance fixtures are pinned with the runtime during the
foundation milestone.

The stdout adapter emits JSON escapes for TOON structural punctuation inside
quoted strings. This preserves the logical string while avoiding a known
reference-decoder ambiguity such as the valid value `[]:`; generated hostile
values are round-tripped through both output formats in release checks.

## Output channels and exit codes

- A domain command writes exactly one selected TOON/JSON result to stdout,
  including expected operational errors and contextual next commands.
- Native help, version, and completions are text on stdout. A native usage
  failure writes generated help to stdout, a text diagnostic to stderr, and
  exits `1`.
- Foreground Effect logs, progress, and internal diagnostics use stderr only.
  They never corrupt a domain result.
- Exit `0` means success, including empty results, idempotent no-ops, and
  successful native meta output.
- Exit `1` means either native syntax rejection or a domain operation that
  could not be completed. There is no exit `2` contract.

Raw dependency messages, stack traces, and progress text must never appear on
domain stdout. `--json` does not alter a native usage failure.

Runtime failures use stable code families: `path.*` for entry/root filesystem
validation, `state.*` for private state access and validation,
`supervisor.*` for lifecycle availability, `http.*` for content-listener start
or readiness, `control.*` for the private local protocol, `review.*` for review
lifecycle or pending-data conflicts, and `feedback.*` for cursor and consumer
conflicts. Public messages may identify the requested path when that is needed
to correct the command, but credentials and raw dependency errors are never
emitted. Unexpected defects are projected as a sanitized `runtime.internal`
domain error after allowlisted diagnostic context is logged to stderr; stack
traces and dependency text stay private.

Effect logging is diagnostic only. Foreground commands route it to stderr.
Normal successes and caller-correctable failures are not duplicated as info
logs; `--log-level debug` or `trace` opts into allowlisted foreground detail.
The detached supervisor writes bounded, rotated JSONL beneath the private
htmlview state directory with `0700` directories and `0600` files. No browser
route or public `logs` command exposes it. The supervisor uses a fixed info
threshold rather than inheriting a starting command's transient log level. Logs
may contain timestamps, levels, fixed operation/span names, stable error codes,
opaque internal IDs, durations, and bounded counts; they must not contain
comments or prompt text, anchors or selectors, DOM/HTML excerpts, form values,
headers, cookies, credentials, full paths, file contents, raw protocol payloads,
dependency error text, or other attacker-controlled strings.

## Home view

With no command, show identity and actionable state rather than a help dump.
Collapse the user's home prefix in the executable path to `~`. Always report
definitive raw-session and non-tombstone review counts, including explicit
empty collections. This keeps durable feedback discoverable after its raw
session or supervisor stops.

```toon
bin: ~/.local/bin/htmlview
description: Serve local HTML through confined loopback HTTP
count: 0
sessions: []
review_count: 0
reviews: []
help[1]: "Run `htmlview serve <entry.html>`"
```

The default non-empty tables contain only decision-relevant fields:

```toon
count: 2
sessions[2]{id,status,url}:
  7sp4k2,ready,"http://h-k7w4m2.localhost:49152/report.html"
  c2m9qa,ready,"http://h-p9c3qa.localhost:49153/public/index.html"
review_count: 2
reviews[2]{id,status,session,drafts,unacknowledged}:
  rv_4m2q7k,ready,7sp4k2,1,0
  rv_8n3d1p,stopped,c2m9qa,0,2
help[4]:
  - "Run `htmlview feedback <review>` to read pending feedback"
  - "Run `htmlview review <session>` for human annotation"
  - "Run `htmlview stop <session>` to stop a session"
  - "Run `htmlview --fields entry,root` to show session paths"
```

Entry and root paths belong behind `--fields`; they are not part of the default
session schema. Review rows contain the stable review ID, lifecycle status,
associated or originating raw-session ID, queued-draft count, and sent but
unacknowledged count. Fully acknowledged deletion/expiry tombstones are omitted
because they require no action. Add future optional fields only when they
remove a demonstrated follow-up query. Requested session fields are selected by
the supervisor rather than discarded after transport. Contextual help
prioritizes pending feedback or cleanup, then creation, stop, and field
discovery as applicable.

Contextual commands preserve fixed choices that affect the next result, such
as `--json`, while leaving runtime values as placeholders such as `<session>`.

## Serve result and filesystem grant

A successful `serve` result includes the exact resolved root because that root
is a security grant, not merely routing configuration:

```toon
session:
  id: 7sp4k2
  status: ready
  url: "http://h-k7w4m2.localhost:49152/public/report.html"
  reused: false
grant:
  root: /workspace
  access: read_all_regular_files_beneath_root
help[1]: "Run `htmlview review <session>` for human annotation"
```

The equivalent JSON is available without changing the operation:

```json
{
  "session": {
    "id": "7sp4k2",
    "status": "ready",
    "url": "http://h-k7w4m2.localhost:49152/public/report.html",
    "reused": false
  },
  "grant": {
    "root": "/workspace",
    "access": "read_all_regular_files_beneath_root"
  },
  "help": ["Run `htmlview review <session>` for human annotation"]
}
```

`serve <entry>` derives its grant from the supplied path's parent before
resolving the entry itself. An entry symlink that resolves outside that
canonical parent is rejected rather than silently broadening the grant.
`--root` explicitly broadens or otherwise changes the grant. The raw service
does not use a filename denylist; callers must choose a root containing only
files they are prepared to expose to the page and other same-origin code.
The user home directory and its ancestors are rejected. A root is also rejected
when its canonical tree overlaps htmlview runtime state in either direction;
state may neither sit beneath a serving grant nor contain one. `session.reused`
is `true` when the identical public entry route/canonical-root session is
already live, making the successful no-op explicit. Different authorized
symlink routes remain distinct because their relative asset URLs differ.

## Review result

`review <session>` lazily creates, reuses, or resumes the one open review for
the raw session's canonical-root/public-entry document identity. It returns
only after both review origins are ready and never opens a browser. A live
review reuses its current origins. A stopped, unended review resumes its stable
review ID and drafts with fresh origins and updates its associated raw-session
ID; `review.reused` is `true` in both cases. An ended review never resumes, so a
later call creates a new review ID and origins.

```json
{
  "review": {
    "id": "rv_4m2q7k",
    "status": "ready",
    "url": "http://r-2f9m.localhost:49154/",
    "reused": false
  },
  "session": {
    "id": "7sp4k2",
    "url": "http://h-k7w4m2.localhost:49152/public/report.html"
  },
  "grant": {
    "root": "/workspace",
    "access": "read_all_regular_files_beneath_root"
  },
  "fidelity": "instrumented_review",
  "help": ["Run `htmlview feedback --wait <review>`"]
}
```

`review.url` is the shared human/agent annotation surface. `session.url` stays
the byte-faithful fidelity and end-to-end testing surface. The review shell and
instrumented content use different random `.localhost` origins; neither origin
adds or changes a route on `session.url`.

The review status is `ready` while its browser surface accepts feedback,
`ended` after the browser sends a final batch, and `stopped` when its associated
session is stopped without an explicit browser end. End persists and
acknowledges the final batch, then closes both review origins without stopping
the raw session. An ended review does not reopen silently. If its raw session
remains live, another `review <session>` creates a new review.
Supervisor recovery changes an orphaned `ready` record to `stopped` before
returning any command result.

## Feedback result

`feedback <review>` immediately returns every currently unacknowledged sent
event, including a definitive zero count. `--wait` instead waits until at least
one such event exists or the review becomes `ended` or `stopped`. Only one
foreground wait may be active for a review; a concurrent wait fails with
`feedback.consumer_busy`.

`--after <cursor>` accepts a non-negative decimal cursor from an earlier result.
It atomically acknowledges events through that cursor before reading or waiting
for newer events. A cursor at or behind the acknowledged position is an
idempotent retry. A cursor beyond the highest position previously returned for
that review fails with `feedback.cursor_ahead` and does not discard anything.
The first read starts at cursor zero. The one-agent-consumer assumption is part
of the `0.1.0` contract; there are no named consumers or independent offsets.

```json
{
  "review": {
    "id": "rv_4m2q7k",
    "status": "ready"
  },
  "cursor": 2,
  "count": 1,
  "feedback": [
    {
      "id": "fb_7c1p9x",
      "kind": "element",
      "comment": "Increase the horizontal padding",
      "entry": "/public/report.html",
      "revision": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "anchor": {
        "selector": "#save",
        "dom_path": "html[0]/body[0]/main[0]/button[1]",
        "tag": "button",
        "text": "Save"
      }
    }
  ],
  "help": ["Run `htmlview feedback --after <cursor> --wait <review>`"]
}
```

The returned `cursor` is the position of the final event in the response, or
the current acknowledged position when `feedback` is empty. Events are bounded
and ordered. Every event has `id`, `kind`, `comment`, `entry`, and the
capture-time SHA-256 `revision`. `kind` is `element` or `freeform`. An `element`
anchor has a selector, DOM-path fallback, tag, and optional normalized text. A
`freeform` event omits `anchor`. Geometry and browser form values are never
agent-output fields.

Stable event IDs and non-destructive reads intentionally favor possible
duplicate delivery over loss. Sent feedback remains available after browser
closure, listener stop, or supervisor restart until acknowledged or explicitly
discarded.

## Review deletion result

`review delete <review>` succeeds only when no drafts remain and all sent
feedback is acknowledged. Otherwise it fails with `review.pending_feedback`,
reports draft and unacknowledged counts, and suggests the feedback or explicit
discard command. `--discard-feedback` explicitly deletes drafts and
unacknowledged events. A successful deletion closes any live shell/content
origins before committing the deletion result and leaves the raw session live.

```toon
delete:
  review: rv_4m2q7k
  deleted: 1
  status: deleted
  discarded:
    drafts: 0
    feedback: 0
```

An ended, acknowledged review or a deletion result retains a bounded 24-hour
tombstone so repeated acknowledge/delete requests are idempotent. After that
tombstone expires, the identifier may return `review.not_found`. A public
review identifier locates review state but is not a control credential.

## Stop result

Stopping one or all sessions reports the affected count and treats an already
stopped target as a successful no-op. `stop --all` is also an acknowledged
supervisor shutdown boundary: success means its content listeners and private
control socket are closed. Stopping a session closes its live raw and review
listeners but preserves review drafts and unacknowledged feedback in the
private state directory. A later `feedback` or `review delete` command may
restart the supervisor to operate on that retained state.

```toon
stop:
  scope: session
  session: 7sp4k2
  stopped: 0
  status: already_stopped
```

## Errors and help

Expected operational errors remain domain results: they identify a stable
code, explain the failed intent, and include a specific corrective command when
one exists. They use TOON by default or logical JSON with `--json`:

```toon
error:
  code: path.entry_not_found
  message: "Entry file does not exist: ./missing.html"
help[1]: "Run `htmlview serve --help` to inspect the command"
```

Command grammar is a separate native Effect CLI boundary. Generated text help
shows usage, arguments, options, defaults, and subcommands. Unknown commands,
unknown flags, invalid option values, missing arguments, and mutually exclusive
inputs use Effect CLI's native text help and diagnostic rather than a
`usage.*` domain schema. They exit `1`; `--json` does not rewrite them. This
keeps one parser and makes generated help, validation, completion, and
dispatch agree.

## Scope of AXI features

A supervisor owns at most 32 raw sessions, and annotation limits bound drafts,
events, target context, and comments. Complete field-selected enumeration and
one feedback batch therefore remain bounded without pagination. Add `--full`,
pagination, or new aggregates only when real output requires them.

Ordinary commands never install agent hooks or edit agent configuration. An
installable Agent Skill generated from the same static guidance as the home
view may be added after the core CLI is stable. Ambient session-start
integration requires separate evidence that its recurring context cost is
worthwhile.
