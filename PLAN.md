# Implementation Plan

## Goal

Deliver a small agent-facing CLI that turns a local HTML entry and explicitly
granted directory root into a byte-faithful, confined loopback HTTP URL.
Browser tools remain separate, interchangeable dependencies chosen by the
caller.

## Current state

- The pre-foundation browser gate is complete and recorded in
  `docs/validation/browser-origin.md`.
- ADR 0002 now assigns every new session a never-reused random `.localhost`
  name bound to `127.0.0.1`; evidence covers cookie sharing, exact-origin
  storage/cache/service-worker revival, and fresh-host isolation.
- Browser neutrality, serving-root disclosure semantics, and the AXI output
  contract are accepted product decisions.
- TOON is the compact default output; `--json` returns the same logical result
  for existing automation.
- Browser validation uses Playwright and independently installed
  `agent-browser`; neither is a runtime dependency.
- Milestone 0 is complete: ADR 0005 selects Node.js 22.13+, TypeScript, npm,
  and `@toon-format/toon`; the CLI foundation and pinned v3.3 conformance tests
  are in place.
- Milestone 1 is complete: canonical disclosure grants, byte-faithful GET/HEAD,
  MIME and conditional responses, exact Host checks, and adversarial
  confinement tests are implemented independently of lifecycle.
- Milestone 2 is complete: authenticated private discovery, concurrency-safe
  detached startup, serialized idempotent sessions, readiness, stop/recovery,
  bounded idle shutdown, and graceful signals are wired through the CLI.
- The next action is Milestone 3 agent interoperability.

Update this document in place. Keep completed work, current validation,
blockers, decisions, and the single next action concise; do not append session
logs.

## Pre-foundation validation gate

Status: Complete. See `docs/validation/browser-origin.md` and ADR 0002.

- Compare direct `file://` navigation with a minimal loopback HTTP fixture for
  root-relative assets, JavaScript modules, fetches, MIME behavior, spaces, and
  Unicode paths.
- Exercise `agent-browser` and at least one other independently installed
  controller without adding either to the runtime.
- Demonstrate that the selected root, rather than the entry alone, is the
  disclosure boundary by having page code request an unreferenced in-root file.
- Run simultaneous sessions and an unrelated loopback service on different
  ports of the same numeric host; verify how overlapping cookies cross those
  ports.
- Reuse a stopped session's port while the browser retains origin-keyed storage,
  caches, and a service worker; determine whether state affects the later
  session.
- Decide the session-origin strategy from evidence. Amend ADR 0002 and the
  threat model if numeric loopback plus ephemeral ports cannot preserve the
  required isolation.

Acceptance:

- A short fixture matrix identifies the cases where `htmlview` materially
  differs from direct local-file navigation.
- Both browser controllers load the HTTP fixture without controller-specific
  serving behavior.
- The in-root disclosure, concurrent cookie behavior, and cross-lifetime origin
  behavior are captured as reproducible tests or structured evidence.
- Any origin-strategy change is recorded before supervisor code fixes the URL
  shape in a public contract.

## Milestone 0: Foundation

Status: Complete. The implementation is recorded in ADR 0005 and the
start-here code map in `ARCHITECTURE.md`.

- Select an implementation language and packaging method using these criteria:
  easy global or one-shot CLI installation, reliable background-process
  support on macOS and Linux, mature static HTTP primitives, and maintained
  TOON v3.3 encoding with conformance fixtures.
- Create the smallest source and test layout that preserves the component
  boundaries in `ARCHITECTURE.md`.
- Add formatter, linter/type checker where applicable, unit-test, and full-check
  commands.
- Define typed, JSON-compatible internal result and error structures; encode
  TOON by default or equivalent JSON with `--json` only at stdout.
- Implement strict command parsing with `--json` and concise structured
  `--help` accepted consistently by every command.
- Implement the AXI home view with executable identity, description, definitive
  session count, explicit empty state, and contextual next commands.
- Support `--fields entry,root` on the home view without expanding the default
  three-field session schema.
- Add HTML fixtures covering nested assets, JavaScript modules, spaces,
  Unicode paths, and root-relative paths.
- Replace the provisional code-map paragraph in `ARCHITECTURE.md` with real
  start-here paths.

Acceptance:

- The no-argument command produces the home view and a definitive empty-session
  result in valid TOON and JSON.
- Missing arguments and unknown flags return structured usage errors and exit
  code 2; missing-argument errors include usage, while unknown-command and
  unknown-flag errors include the relevant valid inputs inline.
- Successes, empty states, no-ops, help, and errors decode to the same logical
  values in both output formats.
- Contextual commands retain `--json` and other relevant fixed choices while
  keeping runtime values as explicit placeholders.
- TOON output passes the pinned v3.3 conformance fixtures, including strings
  containing delimiters, controls, and Unicode.
- One repository command runs all established checks.

## Milestone 1: Faithful static serving

Status: Complete. `src/serving/` owns grant validation and the in-process raw
handler; integration and generic-browser coverage are in `test/http.test.ts`
and `validation/browser-origin/htmlview-serving.spec.mjs`.

- Validate and canonicalize an HTML entry file and its serving root.
- Enforce the grant semantics from ADR 0004: the entry parent is the default
  root, `--root` is explicit, and no broader directory is inferred.
- Implement the raw HTTP handler independently of supervisor lifecycle so it
  can be tested in-process.
- Serve `GET` and `HEAD` with correct MIME types, byte counts, and conditional
  request behavior.
- Map the session root to URL paths without rewriting document or asset bytes.
- Return the entry at its encoded path relative to the root so both document-
  relative and root-relative references resolve as authored.
- Preserve query strings for page behavior while excluding them from file
  lookup.
- Reject malformed encodings, unsupported methods, directories, traversal,
  symlink escape, missing files, and non-HTML entries with explicit outcomes.
- Serve permitted hidden and unreferenced regular files inside the root so
  implementation behavior matches the disclosed grant rather than an implied
  denylist.
- Ensure subsequent requests observe saved file changes.

Acceptance:

- Every fixture loads through a generic browser without `file://` navigation.
- Entry and asset response bodies match their source bytes.
- Root-relative assets work when the caller supplies the corresponding root.
- In-root unreferenced and hidden fixtures follow the documented grant, while
  resolved targets outside it remain inaccessible.
- Containment tests cover encoded traversal, separator variants, symlinks, and
  check/use races as far as the selected runtime permits. A symlinked entry
  cannot choose a broader default root through its target.

## Milestone 2: Supervisor and sessions

Status: Complete. Unit and detached-process coverage includes concurrent first
startup, simultaneous roots, idempotent serve/stop, private permissions,
SIGKILL recovery with a fresh origin, and graceful shutdown.

- Implement one discoverable per-user supervisor with an authenticated
  loopback control endpoint.
- Implement the content-origin strategy accepted by the pre-foundation gate so
  each live session maps its chosen filesystem root to the HTTP origin root and
  cross-lifetime browser state follows the documented isolation contract.
- Protect control operations with a credential stored in a user-private state
  directory.
- Make concurrent startup safe and recover stale discovery records.
- Add idempotent session creation keyed by canonical entry/root identity.
- Implement content-first session listing and targeted/all-session stopping.
- Add bounded idle shutdown and graceful signal handling.
- Ensure successful `serve` output is emitted only after the raw URL is ready.
- Include the exact resolved root and disclosure-grant meaning in every
  successful or reused `serve` result.

Acceptance:

- Independent working directories can hold simultaneous sessions.
- Concurrent `serve` calls converge on one supervisor and one matching
  session.
- A session cannot share or inherit browser state contrary to the decision made
  at the pre-foundation gate.
- A killed supervisor is recovered by the next CLI call without manual cleanup.
- No runtime state is written into a served repository.

## Milestone 3: Agent interoperability

- Validate the returned URL with plain HTTP clients, `agent-browser`, and at
  least one other separately installed browser controller without importing
  either controller into `htmlview`.
- Document browser-neutral copy-paste examples that pass a returned URL to
  external tooling without presenting one controller as part of the product.
- Keep default output minimal and add future `--fields` names only for concrete
  session data that would otherwise require a follow-up command.
- Translate filesystem, bind, state, and HTTP failures into stable structured
  errors with a concrete next command where one can resolve the problem.
- Evaluate an installable Agent Skill generated from the same static command
  guidance as the home view. Do not add ambient session hooks without separate
  evidence that their recurring token cost improves real workflows.

Acceptance:

- An agent can serve a fixture, extract the URL from stdout, navigate with
  either validated browser controller, inspect/interact, and stop the session.
- Normal success, no-op, empty, help, usage-error, and runtime-error outputs
  have logically equivalent TOON and JSON contract tests.
- Progress and dependency diagnostics never contaminate stdout.
- Any shipped Agent Skill has a generated-source drift check and does not
  assume that the binary was globally installed.

## Milestone 4: Security and release hardening

- Complete the checks in `docs/THREAT_MODEL.md`.
- Fuzz or property-test URL decoding and root containment.
- Fuzz structured-output values against TOON and JSON encoders so source paths,
  errors, delimiters, controls, Unicode, and terminal escapes cannot alter the
  result shape.
- Bound request sizes, header timeouts, connection counts, and shutdown waits.
- Verify restrictive state permissions and safe behavior on shared machines.
- Add installation, upgrade, and removal documentation for the chosen package
  channel.
- Exercise clean install and uninstall on supported macOS and Linux versions.

Acceptance:

- All documented security controls have automated coverage or an explicit
  residual-risk note.
- The selected session-origin strategy has browser tests covering concurrent
  cookies and cross-lifetime storage, cache state, and service workers.
- No supported command can bind beyond loopback.
- Release artifacts reproduce the validated version and expose their version
  in CLI output.

## Later: optional human annotation

Do not begin this work until the raw-serving release is stable. First validate
a concrete feedback workflow and decide whether it belongs here or in a
companion project.

Any annotation implementation must:

- consume the existing raw URL rather than replace its handler;
- keep annotation state outside the served project;
- preserve an uninstrumented URL for agent inspection; and
- receive a separate threat and fidelity review before entering the core.

Avoid defining a plugin API, generic feedback schema, browser extension, or
annotation transport before a working second use case requires it.

## Validation matrix

| Layer     | Required evidence                                                                     |
| --------- | ------------------------------------------------------------------------------------- |
| CLI       | parsing, AXI home/help/errors, exit codes, TOON/JSON equivalence, channel separation  |
| Paths     | explicit root grants, in-root disclosure, Unicode, traversal, symlink escape          |
| HTTP      | methods, MIME, bytes, cache validators, missing resources                             |
| Lifecycle | readiness, concurrency, idempotency, recovery, browser-state isolation, idle shutdown |
| Browser   | direct-file comparison and complete fixture interaction through two external tools    |
| Security  | host validation, control authentication, output encoding, permissions, limits         |

## Next action

Complete Milestone 3 interoperability against the returned CLI URL, document
browser-neutral copy-paste workflows, and finish dual-format runtime contract
coverage.
