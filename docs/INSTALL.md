# Install, upgrade, and remove

`htmlview` is distributed as an npm package containing compiled JavaScript. It
supports macOS and glibc-based Linux environments supported by Node.js 22,
on arm64 or x64, with Node.js 22.13 or newer.

## Install

Install the command for the current user with the npm prefix your environment
already uses:

```sh
npm install --global htmlview
htmlview --version
```

For one-shot use without a persistent global install:

```sh
npx --yes htmlview serve ./report.html
```

The npm package does not include a browser. Supply a browser controller
separately when the returned URL needs interactive inspection.

## Upgrade

Stop live sessions before replacing the package so the detached supervisor and
CLI use the same release:

```sh
htmlview stop --all
npm install --global htmlview@latest
htmlview --version
```

An upgrade does not read or modify served projects. Runtime discovery remains
in the platform state directory and is replaced atomically by the next
supervisor.

## Remove

Stop sessions, wait for the supervisor to finish its bounded idle shutdown,
and uninstall the package:

```sh
htmlview stop --all
npm uninstall --global htmlview
```

No project files were created. To remove the now-empty runtime directory too,
delete the applicable path after the supervisor exits:

- macOS: `~/Library/Application Support/htmlview`
- Linux: `${XDG_STATE_HOME}/htmlview` when `XDG_STATE_HOME` is absolute,
  otherwise `~/.local/state/htmlview`

The directory contains only private discovery and startup-lock state. Never
remove it while an `htmlview` supervisor is still active.

## Release validation

`npm run validate:package` packs the current tree, installs it into a clean
temporary prefix, serves a fixture, repeats the install as an upgrade, checks
the structured version against `package.json`, and uninstalls it. The same
tarball workflow runs in `node:22-bookworm` with
`npm run validate:package:linux`.
