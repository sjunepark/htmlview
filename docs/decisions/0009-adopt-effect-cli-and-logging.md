# ADR 0009: Adopt Effect CLI and Effect logging

- Status: Accepted
- Date: 2026-07-16
- Supersedes in part: ADR 0003 and ADR 0007

## Context

`htmlview` adopted Effect v4 for typed failures, schemas, cancellation, and
resource ownership while deliberately retaining a custom command parser and
manual help/output flow. That choice protected an accepted CLI contract during
the execution-model migration, but no version of `htmlview` has been published.
The annotation MVP adds several commands and long-running feedback operations,
so maintaining a second command framework would now duplicate parsing, help,
global-option, error, test, and instrumentation behavior.

Effect v4's CLI module provides typed arguments, flags, subcommands, generated
help, shell completions, a built-in log-level setting, and direct integration
with Effect services. Its native help and usage-error behavior differs from the
earlier AXI contract: help and version are text, usage errors split help to
stdout and diagnostics to stderr, and invalid invocations exit `1` rather than
`2`. Because the earlier interface is unpublished, preserving those differences
is not a compatibility requirement.

Use the [Effect Solutions CLI guide](https://www.effect.solutions/cli) for
composition patterns and the pinned Effect source/API as the behavioral
authority. Logging follows the pinned
[Effect Logger API](https://effect-ts.github.io/effect/effect/Logger.ts.html);
no documentation example overrides captured-channel tests for this prerelease.

## Decision

Use the exactly pinned `effect/unstable/cli` module as the sole command grammar,
parser, help generator, and dispatcher. Define commands with `Command`,
`Argument`, `Flag`, and `GlobalFlag`; provide Node services once at the runtime
entry; and remove the custom parser and manually maintained help models. Do not
add a compatibility parser or pre-parser.

Adopt Effect CLI's native global behavior:

- `--help`/`-h`, `--version`/`-v`, `--completions`, and `--log-level` are
  available as Effect defines them;
- a custom global `--json` setting selects JSON for domain output;
- no arguments still execute htmlview's compact state-oriented home command;
- command examples put flags before positional arguments and do not establish
  a separate htmlview-specific ordering rule; and
- Effect CLI owns command-syntax errors, suggestions, text help/version, and
  exit `1` for invalid invocations.

Keep successful domain results and expected operational failures as ordinary
JSON-compatible values. Emit TOON by default or the logically equivalent JSON
when `--json` is present. Public operational failures retain stable htmlview
error codes and actionable next commands. A reported failure exits `1` without
letting the runtime print a second failure. Native Effect help, version, and
usage failures are not encoded as TOON or JSON, and `--json` does not transform
them. Unexpected defects are projected as a sanitized `runtime.internal`
domain failure; only allowlisted defect metadata reaches diagnostics, and raw
causes are never copied to public output or persisted logs.

Use Effect logging rather than direct diagnostic writes in effectful runtime
paths:

- foreground CLI logs go only to stderr, independently of domain output;
- `--log-level` controls the current foreground command using Effect's native
  levels;
- normal successful foreground commands and caller-correctable domain failures
  are not duplicated as info logs; debug/trace events are opt-in through the
  native level setting;
- the detached supervisor writes structured JSON Lines to a bounded, rotated
  file beneath htmlview's private state directory with `0700` directory and
  `0600` file permissions; exact size and retained-file limits are fixed
  implementation constants covered by tests;
- the supervisor uses a fixed info threshold and does not inherit the
  foreground command's transient `--log-level`;
- log events use stable messages, levels, spans, and allowlisted annotations;
  important operations are named with `Effect.fn`, but spans never capture raw
  command, path, protocol, or domain arguments;
- application code emits through a closed diagnostic-event type, and the sink
  serializes only approved primitive keys rather than arbitrary messages,
  errors, or annotation maps;
- comments, feedback prompt text, anchors or selectors, DOM or HTML excerpts,
  form values, headers, cookies, credentials, full paths, file contents, raw
  protocol payloads, dependency error text, and attacker-controlled strings are
  never logged; and
- logs remain diagnostics only. They are neither feedback transport nor a
  durable domain event stream, and `0.1.0` adds no public logs command.

Keep the native Node HTTP, filesystem, socket, process, and streaming adapters
at their existing security-sensitive leaves. Effect CLI and logging do not
change raw response bytes, headers, paths, Host validation, serving grants,
loopback binding, private control, or source-file immutability. Before the file
sink is enabled, root validation must reject canonical runtime-state/grant
overlap in either direction, so logs can be neither served nor written beneath
a serving grant.

## Consequences

- Command grammar, validation, help, completions, log-level selection, and
  dispatch have one Effect-owned definition.
- The CLI intentionally follows native Effect help, usage-error, and exit-code
  behavior instead of the superseded structured AXI forms. Domain operations
  remain compact and machine-readable.
- Foreground stdout stays safe for one domain result because every installed
  logger is explicitly routed away from it.
- Supervisor diagnostics become recoverable after detachment but add sensitive
  private state that requires bounds, permissions, redaction tests, and cleanup.
- The pinned prerelease CLI and logger APIs require source inspection and the
  full validation gate on every Effect upgrade.
- Package size, cold-start time, generated help, shell completions, logging
  routing, and installed artifacts must be remeasured after the migration.

## Rejected alternatives

- **Keep the custom parser.** This would preserve an unpublished syntax contract
  while annotation duplicates command definitions and instrumentation work.
- **Wrap Effect CLI in the existing parser.** Two parsers would create a shallow
  compatibility layer and ambiguous ownership of help, validation, and errors.
- **Recreate the old contract with a custom Effect CLI formatter.** That would
  retain most manual help/error machinery while depending on unstable runner
  internals; native Effect behavior is the chosen contract.
- **Write Effect logs to stdout.** Logs would corrupt TOON/JSON domain results.
- **Use unbounded supervisor logs or feedback as logs.** Unbounded diagnostics
  create a storage and privacy risk, while feedback requires its durable cursor
  queue and explicit trust labeling.
