# htmlview

`htmlview` turns a local HTML entry and an explicitly granted directory into a
ready, byte-faithful loopback URL for any separately supplied browser tool. Its
first release also adds a different instrumented review URL where a human can
send structured feedback without changing raw responses or served files.

Use direct `file://` navigation when its behavior is sufficient. `htmlview`
exists for browser-neutral HTTP behavior: root-relative assets, modules,
fetches, stable origins, readiness, and lifecycle management. It does not
install, launch, or automate a browser.

## Status

Raw serving, the Effect CLI grammar, native output boundary, and foreground
and private diagnostic seams, durable feedback, and the trusted review surface
are implemented. Ready reviews now refresh automatically after confirmed entry
or bounded linked-resource changes. The complete release matrix passes; `0.1.0`
is release-ready but has not been published.

The public docs describe the implemented `0.1.0` release candidate. See the repository
[`PLAN.md`](https://github.com/sjunepark/htmlview/blob/main/PLAN.md) for
implementation truth.

## Try the implemented workflows

From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm example:standalone
pnpm example:relative
pnpm example:root
pnpm example:review
```

Each command returns after the detached supervisor confirms its URL is ready.
`example:review` prints the separate instrumented review URL plus its review and
raw-session IDs; the other commands print byte-faithful raw URLs.
Use `pnpm example:list` and `pnpm example:stop` to inspect or stop this
checkout's example sessions. The committed
[examples](https://github.com/sjunepark/htmlview/tree/main/examples) are also
black-box E2E fixtures.

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
- automatically refresh the instrumented review iframe when the original entry
  or a bounded linked resource loaded by the review changes, without injecting
  a reload client into raw responses;
- persist feedback outside the serving grant and deliver it through a
  retry-safe foreground agent command;
- keep the local server alive across CLI invocations;
- let agents list and stop their serving sessions;
- emit compact TOON by default, with the same logical result available as JSON
  through `--json`;
- use pinned Effect CLI for native text help, version, completions, log-level
  selection, syntax validation, and dispatch; and
- follow the applicable [AXI](https://axi.md/) conventions for agent-facing
  output, errors, discovery, and next commands.

It will not install or control a browser, mutate source, instrument the raw URL,
publish content beyond the machine, emulate an application server, keep
discussion threads, show agent replies, or edit source automatically. The
[Product requirements](docs/PRODUCT.md) own the complete scope.

Every permitted file below the selected root is readable from the raw origin,
including hidden files. Use an isolated artifact directory when the page is
untrusted or its surrounding project contains secrets. The user home directory
and any broader ancestor are not valid serving roots. A serving root and
htmlview's private state tree must also be canonically disjoint in both
directions.

The accepted annotation workflow is:

```sh
htmlview serve ./report.html
htmlview review <session>
htmlview feedback --wait <review>
```

The human and agent may both open the review URL, but only the raw URL is the
fidelity and end-to-end testing reference. The foreground feedback command is
the agent wake path; diagnostic logs never deliver feedback. While the review
remains open, editing the original entry or a linked resource loaded by the
review refreshes its iframe automatically. The raw URL serves the latest bytes
on its next request, but `htmlview` does not force already-loaded raw consumers
to refresh.

## Start here

- [Install, upgrade, and remove](docs/INSTALL.md)
- [CLI contract](docs/CLI.md)
- [Browser-controller interoperability](docs/INTEROPERABILITY.md)
- [Documentation map](docs/README.md)
- [Architecture decision index](docs/decisions/README.md)
