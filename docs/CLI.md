# Agent-facing CLI contract

## Purpose

`htmlview` is an Agent eXperience Interface (AXI): its primary caller is an
agent executing shell commands. The interface follows the applicable
principles from [axi.md](https://axi.md/): compact structured output,
definitive results, strict input handling, content-first discovery, and
actionable next commands.

The CLI exposes browser-neutral serving state. It does not launch, configure,
or depend on a browser controller.

## Command surface

Version one keeps four operations:

```sh
htmlview [--fields <name,...>] [--json]
htmlview serve <entry.html> [--root <directory>]
htmlview stop <session>
htmlview stop --all
```

Every command accepts `--json` and `--help`. The home view accepts
`--fields entry,root` to add those fields to each session row. Unknown
commands, arguments, flags, and field names are usage errors; they are never
ignored.

`--help` succeeds without requiring operational arguments or contacting the
supervisor. It is the universal discovery flag, not an operation.

Commands never prompt. Repeating a successful `serve` or `stop` request is a
successful no-op.

## Logical result model

Commands produce ordinary JSON-compatible values internally. The output
encoder is selected only at the stdout boundary:

- TOON is the compact default and initially targets the
  [TOON v3.3 specification](https://toonformat.dev/reference/spec.html).
- `--json` emits the same logical value as JSON.
- Both formats use the same field names, value meanings, error codes, and exit
  codes.
- Contract tests decode both representations and compare their logical values.

The implementation must use a maintained encoder rather than interpolate
paths, errors, or other untrusted values into either format. The selected TOON
implementation and conformance fixtures are pinned with the runtime during the
foundation milestone.

## Output channels and exit codes

- Stdout contains the selected structured result, including errors, help, and
  contextual next commands.
- Stderr contains progress, debug logging, and internal diagnostics only.
- Exit `0` means success, including empty results and idempotent no-ops.
- Exit `1` means the requested operation could not be completed.
- Exit `2` means invalid command syntax or input.

Raw dependency messages, stack traces, and progress text must never appear on
stdout.

## Home view

With no command, show identity and live state rather than a help dump. Collapse
the user's home prefix in the executable path to `~`. Always report the total
session count and make an empty result explicit.

```toon
bin: ~/.local/bin/htmlview
description: Serve local HTML through confined loopback HTTP
count: 0
sessions: []
help[1]: "Run `htmlview serve <entry.html>`"
```

The default non-empty session table contains only decision-relevant fields:

```toon
count: 2
sessions[2]{id,status,url}:
  7sp4k2,ready,"http://h-k7w4m2.localhost:49152/report.html"
  c2m9qa,ready,"http://h-p9c3qa.localhost:49153/public/index.html"
help[1]: "Run `htmlview stop <session>` to stop a session"
```

Entry and root paths belong behind `--fields`; they are not part of the default
list schema. Add future optional fields only when they remove a demonstrated
follow-up query.

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
grant:
  root: /workspace
  access: read_all_regular_files_beneath_root
```

The equivalent JSON is available without changing the operation:

```json
{
  "session": {
    "id": "7sp4k2",
    "status": "ready",
    "url": "http://h-k7w4m2.localhost:49152/public/report.html"
  },
  "grant": {
    "root": "/workspace",
    "access": "read_all_regular_files_beneath_root"
  }
}
```

`serve <entry>` derives its grant from the supplied path's parent before
resolving the entry itself. An entry symlink that resolves outside that
canonical parent is rejected rather than silently broadening the grant.
`--root` explicitly broadens or otherwise changes the grant. The raw service
does not use a filename denylist; callers must choose a root containing only
files they are prepared to expose to the page and other same-origin code.

## Errors and help

Errors identify a stable code, explain the failed intent, and include a
specific corrective command when one exists:

```toon
error:
  code: usage.unknown_flag
  message: Unknown flag --stat for `serve`
  valid_flags[3]: "--root","--json","--help"
help[1]: "Run `htmlview serve --help` for complete examples"
```

If a valid `--json` flag is present, errors use the JSON representation. Each
command's `--help` result contains its usage, required arguments, accepted
flags and defaults, and two or three examples; it does not dump unrelated
commands. Unknown-flag errors include that command's valid flags inline so the
agent can correct the invocation without a discovery call. Unknown-command
errors similarly include valid commands, and missing-argument errors include
the complete usage form.

## Scope of AXI features

Version one has no long-form content, pagination, or expensive derived data, so
truncation and aggregation beyond definitive session counts are unnecessary.
Add `--full`, pagination, or new aggregates only when real output requires
them.

Ordinary commands never install agent hooks or edit agent configuration. An
installable Agent Skill generated from the same static guidance as the home
view may be added after the core CLI is stable. Ambient session-start
integration requires separate evidence that its recurring context cost is
worthwhile.
