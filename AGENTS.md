# AGENTS.md

## Current state

- This repository is a documentation-only scaffold. No setup, build, lint, or
  test commands exist yet.
- Read `docs/PRODUCT.md`, `docs/CLI.md`, `ARCHITECTURE.md`,
  `docs/THREAT_MODEL.md`, and `PLAN.md` before implementation work.
- Keep `PLAN.md` current as milestones, validation, blockers, and the next
  action change.

## Product constraints

- Keep browser installation and browser automation outside this repository.
- Keep the serving core browser-neutral; browser tools are interoperability
  targets and examples, not runtime dependencies.
- Preserve entry document and asset bytes on the raw serving path. Do not
  inject scripts, styles, overlays, or live-reload clients there.
- Treat the selected serving root as an explicit read-disclosure grant. Return
  it from `serve`, never infer a root broader than the entry's parent, and do
  not imply that filename denylisting protects in-root files.
- Treat annotations as an optional consumer of the serving core, not a mode
  that changes raw serving behavior.
- Never write to the user's served files or directories.

## Security constraints

- Bind only to loopback in the first release; do not add a public-bind escape
  hatch without a new threat-model review and explicit product decision.
- Resolve and authorize every requested file against the session root,
  including symlink targets. Reject traversal and root escape.
- Authenticate control operations and keep runtime state outside repositories
  with user-only permissions.
- Do not rely on CORS alone for protection from local or cross-origin callers.

## Agent-facing CLI

- Follow `docs/CLI.md` and the applicable AXI conventions.
- Keep domain data as ordinary JSON-compatible structures. Encode TOON by
  default or logically equivalent JSON with `--json` only at stdout.
- Reserve stdout for structured results, structured errors, and actionable
  next commands. Send progress and diagnostics to stderr.
- Make commands non-interactive, reject unknown input, and make repeated
  serve/stop operations idempotent.
- Keep default schemas minimal, make empty results and total counts definitive,
  and use stable error codes and exit codes `0`, `1`, and `2`.
- With no arguments, identify the executable and tool, then show active
  sessions and a few relevant next commands rather than a full help dump.

## Change expectations

- Add tests with implementation changes, including integration tests for HTTP
  behavior and adversarial tests for path confinement.
- Update `ARCHITECTURE.md` when component ownership or runtime flow changes.
- Update `docs/CLI.md` and its contract tests when commands, fields, formats,
  errors, or exit behavior change.
- Add or amend an ADR in `docs/decisions/` when changing a recorded decision.
- Until project tooling exists, validate documentation changes with
  `git diff --check` and verify every relative Markdown link resolves.
