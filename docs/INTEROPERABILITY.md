# Browser-controller interoperability

`htmlview` returns an ordinary loopback HTTP URL. It does not install, launch,
or configure browsers, so callers can pass that URL to whichever separately
supplied HTTP client or browser controller fits their workflow.

## Copy-paste workflow

Request JSON when a shell needs to extract the URL without a TOON decoder:

```sh
result="$(htmlview serve --json ./report.html)"
url="$(printf '%s' "$result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.session.url)')"
```

The resulting `$url` is ready before `serve` returns. For example, an HTTP
client can check it directly:

```sh
curl --fail --silent --show-error "$url" >/dev/null
```

Browsers recognize every name beneath the special-use `.localhost` domain.
Some non-browser Linux resolvers do not. For those clients, connect to
`127.0.0.1` while retaining the URL's exact `Host` authority; the Linux package
smoke test demonstrates this with Node's `http` client. Do not replace the URL
hostname itself, because the content listener rejects a mismatched `Host`.

Or pass the same value to an external browser tool. These are interoperability
examples, not product dependencies:

```sh
HTMLVIEW_URL="$url" browser-use <<'PY'
import os
new_tab(os.environ["HTMLVIEW_URL"])
wait_for_load()
capture_screenshot()
print(page_info())
PY
```

```js
await page.goto(process.env.HTMLVIEW_URL);
```

When inspection is complete, use the `session.id` from the original result:

```sh
session="$(printf '%s' "$result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.session.id)')"
htmlview stop --json "$session"
```

## Human review workflow (`0.1.0` target)

Annotation uses a separate instrumented URL and never changes `$url`:

```sh
review_result="$(htmlview review --json "$session")"
review_url="$(printf '%s' "$review_result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.url)')"
review_id="$(printf '%s' "$review_result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.id)')"
htmlview feedback --wait --json "$review_id"
```

Open `$review_url` with any external browser or controller. A human can queue
and send element-targeted or freeform comments; the foreground `feedback`
command completes with one durable structured batch. It is the agent wake-up
boundary. Supervisor logs are diagnostics only and cannot replace the feedback
queue.

For an iterative review, the human uses Send rather than Send & End. The agent
applies the batch to the original selected entry, acknowledges the returned
cursor, and waits again:

```sh
htmlview feedback --after <cursor> --wait --json "$review_id"
```

A ready review automatically refreshes its instrumented iframe after a
confirmed byte change to that entry. It also tracks authorized linked-resource
responses admitted within the observer's size and count bounds that complete
successfully; other resources require a manual or entry-driven reload. Use the
original raw `$url` for fidelity checks and application E2E. It serves the
latest bytes on the next request.

An external browser/controller must reload any already-open raw page when it
wants to observe those bytes.

## Validated controllers

The implemented raw-serving validation passes a CLI-returned URL through two
independently installed controllers:

- `pnpm run validate:interoperability` uses Playwright Chromium.
- `pnpm run validate:browser-use` uses the separately installed `browser-use`
  executable and its default connection to a running Chrome instance.

Neither controller is imported by the runtime or included in the published
package. Before `0.1.0`, the same independence requirement also covers the
complete review/send/feedback browser flow.

## Codex agent acceptance validation

From a source checkout, `pnpm run validate:codex` performs an opt-in acceptance
evaluation with a fresh ephemeral `codex exec` session. It builds, packs, and
installs htmlview under a temporary prefix; submits one element-targeted comment
through Playwright; lets Codex retrieve and acknowledge that batch through the
installed CLI; and verifies the exact source edit, raw bytes, and automatic
review refresh.

This evaluation is intentionally separate from `pnpm run check`. It currently
supports macOS and glibc-based Linux only because its bounded tree termination,
Unix-domain socket probes, and command paths require that platform contract. It
also requires Playwright Chromium, an installed and authenticated Codex CLI with
permission profile support, model capacity, and a network call.
`HTMLVIEW_CODEX_BINARY` may select another Codex executable,
`HTMLVIEW_CODEX_MODEL` may select a model, and `HTMLVIEW_CODEX_TIMEOUT_MS` may
change the default five-minute agent timeout.

The harness removes model credentials from build, pack, install, Git, browser,
htmlview, and sandbox-probe subprocesses; only the explicit `codex exec` child
receives the caller's Codex environment. Generated commands inherit none of that
caller environment; the harness sets only the installed-package path and
temporary private-state location, while Codex may add its own sandbox and proxy
variables. A pre-agent sentinel verifies that caller variables remain excluded.

Model-generated commands run under a custom least-privilege permission profile.
The fixture workspace is read-only except for its served `site` subtree; the
installed package is read-only; and the isolated private state is writable so
the CLI can maintain its permission and lifecycle invariants. Unrelated user and
temporary paths outside Codex's minimal platform/runtime roots are inaccessible.
The matching network profile permits only the temporary htmlview control socket.
Before starting the model, the harness proves allowed fixture reads and writes,
denies an outside read and write, completes one installed-CLI read through the
allowed socket, and rejects a second Unix socket. The timeout owns a separate
process group, escalates from termination to forced termination, caps captured
output, and waits for descendant-held pipes to close before cleanup.

## Agent Skill

The package ships a portable, manually invoked skill at
[`skills/htmlview`](../skills/htmlview/SKILL.md). Install the version-matched
copy through the [installation workflow](INSTALL.md#install-the-agent-skill),
then invoke it as `$htmlview`. Its OpenAI metadata disables implicit invocation.
The portable skill description carries the same explicit-invocation rule for
clients that do not consume that metadata.

The skill keeps `htmlview --help` and each subcommand's live help authoritative
for syntax. It adds the cross-command process that help alone cannot carry:
choosing the narrowest serving grant, preserving the raw/review fidelity
boundary, handing URLs to an external browser, consuming and explicitly
acknowledging durable feedback, and cleaning up only the selected lifecycle.
It installs no ambient session hook and adds no browser dependency.
