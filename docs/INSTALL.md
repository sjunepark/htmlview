# Install, upgrade, and remove

`htmlview` is distributed as an npm package containing compiled JavaScript. It
supports macOS and glibc-based Linux environments supported by Node.js 22,
on arm64 or x64, with Node.js 22.13 or newer.

The package identity is `@sejunpark/htmlview`; the installed executable remains
`htmlview`. The package is not published yet.

## Install

Install the command for the current user with the npm prefix your environment
already uses:

```sh
npm install --global @sejunpark/htmlview
htmlview --version
```

For one-shot use without a persistent global install:

```sh
npx --yes @sejunpark/htmlview serve ./report.html
```

The npm package does not include a browser. Supply a browser controller
separately when the returned URL needs interactive inspection.

## Upgrade

Stop live sessions before replacing the package so the detached supervisor and
CLI use the same release:

```sh
htmlview stop --all
npm install --global @sejunpark/htmlview@latest
htmlview --version
```

`stop --all` waits for the old supervisor and all content listeners to close.
An upgrade does not read or modify served projects; the next command creates a
fresh version-compatible control socket.

## Remove

Stop sessions and the supervisor, then uninstall the package:

```sh
htmlview stop --all
npm uninstall --global @sejunpark/htmlview
```

No project files were created. To remove the now-empty runtime directory too,
delete the applicable path after the supervisor exits:

- macOS: `~/Library/Application Support/htmlview`
- Linux: `${XDG_STATE_HOME}/htmlview` when `XDG_STATE_HOME` is absolute,
  otherwise `~/.local/state/htmlview`

The directory contains only the private control socket and lifetime ownership
lock. Never remove it while an `htmlview` supervisor is active.

Rare operating-system PID reuse after a crash can conservatively preserve a
stale lock. If commands keep reporting `supervisor.unavailable`, inspect
`supervisor.lock/owner.json`. Only after confirming its PID belongs to an
unrelated process and no htmlview supervisor is active, remove the inactive
runtime directory and retry.

## Release validation

`npm run validate:package` packs the current tree, installs it into a clean
temporary prefix, serves a fixture, repeats the same-artifact install, checks
the structured version against `package.json`, and uninstalls it. The same
tarball workflow runs in `node:22-bookworm` with
`npm run validate:package:linux`.
