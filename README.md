# htmlview

`htmlview` turns a local HTML entry file and an explicitly granted directory
root into a byte-faithful, confined loopback URL that an agent can hand to any
browser-control tool.

Browser controllers differ in their `file://` support, and local-file pages do
not consistently reproduce HTTP origins, root-relative assets, module loading,
or fetch behavior. Some controllers, including `agent-browser`, can open local
files directly; that is sufficient when file-origin behavior is acceptable.
`htmlview` exists for the browser-neutral HTTP case and does not automate a
browser itself.

## Status

Implementation in progress. The Node.js/TypeScript CLI, confined raw serving,
and detached supervisor lifecycle are complete; interoperability and release
hardening remain.

## Product boundary

The first release will:

- serve an HTML entry file and its local assets from loopback;
- preserve the entry document and asset bytes on the raw route;
- treat the selected root as an explicit read-disclosure grant and return that
  grant in the `serve` result;
- return a stable, agent-readable URL;
- keep the local server alive across CLI invocations;
- let agents list and stop their serving sessions;
- emit compact TOON by default, with the same logical result available as JSON
  through `--json`; and
- follow the applicable [AXI](https://axi.md/) conventions for agent-facing
  output, errors, discovery, and next commands.

The first release will not:

- install, launch, or control `agent-browser`, Chrome, Playwright, or another
  browser tool;
- interpret the rendered page or report whether it looks correct;
- inject live reload, inspection helpers, or annotation code into the raw
  document;
- replace an application's existing development server; or
- publish local content beyond the machine.

Every permitted file below the selected root is readable from the raw origin,
including hidden files. Use an isolated artifact directory when the page is
untrusted or its surrounding project contains secrets.

Human annotations are a possible later layer. They must consume the faithful
serving core without changing its raw response path.

## Start here

- [Product requirements](docs/PRODUCT.md)
- [Agent-facing CLI contract](docs/CLI.md)
- [Architecture](ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Implementation plan](PLAN.md)
- [Core-boundary decision](docs/decisions/0001-separate-serving-from-browser-control.md)
- [Supervisor decision](docs/decisions/0002-per-user-loopback-supervisor.md)
- [AXI output decision](docs/decisions/0003-adopt-an-axi-output-contract.md)
- [Serving-root grant decision](docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md)
- [Runtime and packaging decision](docs/decisions/0005-use-node-typescript-and-npm-packaging.md)
