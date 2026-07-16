# htmlview

`htmlview` turns a local HTML entry file and an explicitly granted directory
root into a byte-faithful, confined loopback URL that an agent can hand to any
browser-control tool. Its first release will also provide a separate
instrumented review URL for human comments without changing raw responses or
served files.

Browser controllers differ in their `file://` support, and local-file pages do
not consistently reproduce HTTP origins, root-relative assets, module loading,
or fetch behavior. Some controllers, including Browser Use, can open local
files directly; that is sufficient when file-origin behavior is acceptable.
`htmlview` exists for the browser-neutral HTTP case and does not automate a
browser itself.

CLI commands are short-lived control operations, not foreground development
servers. `htmlview serve` returns after the detached supervisor confirms the
URL is ready; the URL remains live until its session is stopped.

See [browser-controller interoperability](docs/INTEROPERABILITY.md) for the
copy-paste URL handoff and independently validated controller paths.

To exercise a source checkout immediately, run `pnpm example:standalone`,
`pnpm example:relative`, or `pnpm example:root`. The committed
[examples](https://github.com/sjunepark/htmlview/tree/main/examples) cover
single-file, relative-asset, and explicit serving-root workflows and are also
used by the black-box E2E suite. Inspect active example sessions with
`pnpm example:list` and clean them up with `pnpm example:stop`; the installed
`htmlview` executable is not required for this source-checkout workflow.

## Status

The raw-serving implementation and broad validation suite are in place. Human
annotation is now a required `0.1.0` milestone: its contracts are accepted, but
its runtime is not yet implemented. The accepted Effect CLI/logging migration
is the next prerequisite: it replaces the current custom parser before review
commands are added. The artifact has not been published; its npm identity is
`@sejunpark/htmlview`, while the installed executable remains `htmlview`.

## Product boundary

The first release will:

- serve an HTML entry file and its local assets from loopback;
- preserve the entry document and asset bytes on the raw route;
- treat the selected root as an explicit read-disclosure grant and return that
  grant in the `serve` result;
- return a stable, agent-readable URL;
- lazily attach a separate review URL with isolated trusted-shell and
  instrumented-content origins;
- let a human queue element-targeted and freeform comments without writing to
  the served project;
- persist feedback outside the serving grant and deliver it through a
  cursor-safe foreground agent command;
- keep the local server alive across CLI invocations;
- let agents list and stop their serving sessions;
- emit compact TOON by default, with the same logical result available as JSON
  through `--json`;
- use pinned Effect CLI for native text help, version, completions, log-level
  selection, syntax validation, and dispatch; and
- follow the applicable [AXI](https://axi.md/) conventions for agent-facing
  output, errors, discovery, and next commands.

The first release will not:

- install, launch, or control Browser Use, Chrome, Playwright, or another
  browser tool;
- interpret the rendered page or report whether it looks correct;
- inject live reload, inspection helpers, or annotation code into the raw
  document;
- support text-range quote anchors, keep submitted comments as pins or
  discussion threads, show agent replies in the review page, or edit source
  automatically;
- replace an application's existing development server; or
- publish local content beyond the machine.

Every permitted file below the selected root is readable from the raw origin,
including hidden files. Use an isolated artifact directory when the page is
untrusted or its surrounding project contains secrets. The user home directory
and any broader ancestor are not valid serving roots. A serving root and
htmlview's private state tree must also be canonically disjoint in both
directions.

The accepted `0.1.0` workflow is:

```sh
htmlview serve ./report.html
htmlview review <session>
htmlview feedback --wait <review>
```

The human and agent may both open the review URL, but only the raw URL is the
fidelity and end-to-end testing reference. The foreground feedback command is
the agent wake path. Foreground Effect logs use stderr; detached supervisor
logs are bounded private diagnostics outside served roots and never contain
annotation content or deliver feedback.

## Start here

- [Install, upgrade, and remove](docs/INSTALL.md)
- [Runnable examples](https://github.com/sjunepark/htmlview/tree/main/examples)
- [Product requirements](docs/PRODUCT.md)
- [Domain language](CONTEXT.md)
- [Agent-facing CLI contract](docs/CLI.md)
- [Browser-controller interoperability](docs/INTEROPERABILITY.md)
- [Architecture](ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security validation evidence](docs/SECURITY_VALIDATION.md)
- [Core-boundary decision](docs/decisions/0001-separate-serving-from-browser-control.md)
- [Supervisor decision](docs/decisions/0002-per-user-loopback-supervisor.md)
- [AXI output decision](docs/decisions/0003-adopt-an-axi-output-contract.md)
- [Serving-root grant decision](docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md)
- [Runtime and packaging decision](docs/decisions/0005-use-node-typescript-pnpm-and-the-npm-registry.md)
- [Private control-socket decision](docs/decisions/0006-use-a-private-control-socket.md)
- [Effect execution-model decision](docs/decisions/0007-adopt-effect-v4.md)
- [Review and feedback decision](docs/decisions/0008-separate-raw-serving-from-instrumented-review.md)
- [Effect CLI and logging decision](docs/decisions/0009-adopt-effect-cli-and-logging.md)
