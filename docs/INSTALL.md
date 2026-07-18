# Install, upgrade, and remove

> **Status:** The package is not published. These instructions describe the
> accepted `0.1.0` interface. Annotation commands and the review runtime are
> implemented, including bounded entry and linked-resource refresh, and the
> complete release validation matrix passes.

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

## Install the Agent Skill

The npm package includes the portable, manually invoked `htmlview` Agent Skill
but does not edit any agent configuration. After a global CLI installation,
inspect and install the version-matched skill with the Agent Skills installer:

```sh
skill_source="$(npm root --global)/@sejunpark/htmlview/skills"
npx skills add "$skill_source" --list
npx skills add "$skill_source" --skill htmlview --copy
```

Choose the intended agent and project or user scope when prompted. The installed
skill delegates command syntax to the installed CLI's live help and adds the
serving-grant, browser-handoff, durable-feedback, and cleanup process that spans
commands. Invoke it explicitly as `$htmlview`; its OpenAI metadata disables
implicit invocation, and its portable description carries the same rule for
other clients.

## Review an installed page

Until the package is published, create and install the candidate tarball from a
source checkout first:

```sh
candidate_dir="$(mktemp -d)"
tarball="$(pnpm pack --json --pack-destination "$candidate_dir" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.filename)')"
npm install --global "$candidate_dir/$tarball"
htmlview --version
```

Create the raw session first, then attach its separate review surface:

```sh
served="$(htmlview serve ./report.html --json)"
session="$(printf '%s' "$served" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.session.id)')"
reviewed="$(htmlview review "$session" --json)"
review_url="$(printf '%s' "$reviewed" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.url)')"
review_id="$(printf '%s' "$reviewed" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.id)')"
printf 'Open this URL in an external browser: %s\n' "$review_url"
htmlview feedback --wait --json "$review_id"
```

Use **Send selected** in the review to keep iterating. Editing the original
entry automatically refreshes the instrumented review iframe. Linked resources
are tracked only when an authorized response is admitted within the observer's
size and count bounds and completes successfully; confirmed changes also
refresh the iframe. Other resources require a manual or entry-driven reload.
The raw URL remains byte-faithful and passive.
A later feedback wait acknowledges the prior
batch by passing its returned cursor with `--after <cursor>`. See
[Browser-controller interoperability](INTEROPERABILITY.md#human-review-workflow-010-target)
for the complete cursor loop and cleanup commands.

## Upgrade

Stop live sessions before replacing the package so the detached supervisor and
CLI use the same release:

```sh
htmlview stop --all
npm install --global @sejunpark/htmlview@latest
htmlview --version
```

Repeat [Install the Agent Skill](#install-the-agent-skill) after an upgrade to
refresh any copied skill installation from the same package version.

`stop --all` waits for the old supervisor and all raw/review content listeners
to close. It preserves annotation drafts and unacknowledged feedback. An
upgrade does not read or modify served projects; the next command validates
private state and creates a fresh version-compatible control socket.

There is intentionally no cross-protocol compatibility layer. If an upgrade was
installed without stopping a supervisor and the new CLI reports
`supervisor.protocol_mismatch`, reinstall the exact prior htmlview release, run
its `htmlview stop --all`, and then install the desired release again. When only
the package version differs and the control protocol still matches, the new
CLI can perform `stop --all` directly.

## Remove

Stop sessions and the supervisor, then uninstall the package:

```sh
htmlview stop --all
npm uninstall --global @sejunpark/htmlview
```

A copied Agent Skill is managed separately. Remove it through the same agent
and project or user scope in the Agent Skills installer when it is no longer
needed; uninstalling the CLI package does not remove it.

The htmlview CLI itself created no project files. A project-scoped Agent Skill
is the installer-managed exception described above. To remove all private
htmlview state—including
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
temporary prefix, serves a fixture, starts its review shell, proves feedback
state can be read and observer-driven entry changes are detected through the
installed executable, repeats the same-artifact install, checks the native text
version against `package.json`, and uninstalls it. The same tarball workflow
runs in `node:22-bookworm` with
`pnpm run validate:package:linux`.
