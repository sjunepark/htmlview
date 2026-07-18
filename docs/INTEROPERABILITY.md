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

## Agent Skill evaluation

Version one does not ship an Agent Skill. The structured home view and native
Effect CLI command help expose the workflow, while a generated skill would
duplicate that static guidance and would need installation-aware invocation
rules. Revisit a generated skill only if observed workflows need more guidance
than `htmlview`, `htmlview serve --help`, `htmlview review --help`, and
`htmlview feedback --help` provide. Ambient session hooks remain out of scope.
