# Install, upgrade, and remove

> **Status:** The package is not published. These instructions describe the
> accepted `0.1.0` interface; annotation commands are still being implemented.

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

`--version` is native Effect CLI text output. Use `htmlview --help` for generated
command help and `htmlview --completions <bash|zsh|fish|sh>` when installing
shell completions. `--json` applies to domain commands, not these meta options.

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

`stop --all` waits for the old supervisor and all raw/review content listeners
to close. It preserves annotation drafts and unacknowledged feedback. An
upgrade does not read or modify served projects; the next command validates
private state and creates a fresh version-compatible control socket.

## Remove

Stop sessions and the supervisor, then uninstall the package:

```sh
htmlview stop --all
npm uninstall --global @sejunpark/htmlview
```

No project files were created. To remove all private htmlview state—including
pending annotation drafts/feedback, retry tombstones, ownership records, and
bounded diagnostic logs—delete the applicable path only after the supervisor
exits:

- macOS: `~/Library/Application Support/htmlview`
- Linux: `${XDG_STATE_HOME}/htmlview` when `XDG_STATE_HOME` is absolute,
  otherwise `~/.local/state/htmlview`

The directory is outside served repositories and uses user-only permissions.
Never remove it while an `htmlview` supervisor is active. Removing it is an
explicit destructive discard of any retained feedback; prefer
`htmlview review delete` when only one review should be removed.

Rare operating-system PID reuse after a crash can conservatively preserve a
stale lock. If commands keep reporting `supervisor.unavailable`, inspect
`supervisor.lock/owner.json` beneath the platform state directory. Only after
confirming its PID belongs to an unrelated process and no htmlview supervisor
is active, remove the `supervisor.lock` directory and retry. Leave the rest of
the state directory intact; the next supervisor recovers an inactive control
socket, while annotation records and diagnostic logs remain available.

## Release validation

`pnpm run validate:package` packs the current tree, installs it into a clean
temporary prefix, serves a fixture, repeats the same-artifact install, checks
the native text version against `package.json`, and uninstalls it. The same
tarball workflow runs in `node:22-bookworm` with
`pnpm run validate:package:linux`.
