# ADR 0003: Adopt an AXI output contract

- Status: Accepted
- Date: 2026-07-15

## Context

The primary caller is an agent using shell execution. It needs compact output
by default, but browser controllers and ordinary shell tooling commonly
consume JSON. A format-specific domain model would couple command behavior to
serialization and make two output formats drift.

[AXI](https://axi.md/) provides relevant conventions for token-efficient
output, definitive empty states, strict usage errors, content-first discovery,
and contextual next commands.

## Decision

Commands create ordinary JSON-compatible result and error values. The stdout
boundary emits TOON by default and the same logical value as JSON when the
caller passes `--json`.

The detailed contract lives in [`docs/CLI.md`](../CLI.md). In particular:

- default schemas remain minimal and collection results include definitive
  counts;
- stdout contains structured data, errors, help, and next commands while
  stderr contains progress and diagnostics;
- exit codes distinguish success, runtime failure, and usage failure;
- empty results and idempotent no-ops are explicit successes;
- no arguments produce a compact home view with executable identity, active
  sessions, and relevant next commands; and
- unknown input is rejected with a self-correcting structured error.

The initial TOON encoder targets specification v3.3 and is validated with
conformance fixtures. Both encodings have logical-equivalence contract tests.

## Consequences

- Agents receive the token-efficient default recommended by AXI.
- JSON consumers do not need a TOON parser or an output-scraping adapter.
- Adding a field or error code requires updating one logical schema and both
  serialization snapshots.
- Help and errors remain machine-readable rather than becoming an unrelated
  human-only channel.
- TOON specification changes are isolated at the encoding boundary.

## Rejected alternatives

- **TOON only.** This minimizes default tokens but unnecessarily restricts
  interoperability with existing automation.
- **JSON only.** This is ubiquitous but gives up the compact agent-facing
  default selected for the product.
- **Separate schemas per format.** Divergent contracts would make caller
  behavior depend on presentation rather than command semantics.
- **Unstructured human output.** Agents would need brittle parsing and extra
  discovery calls.
