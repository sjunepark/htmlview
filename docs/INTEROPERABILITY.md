# Browser-controller interoperability

`htmlview` returns an ordinary loopback HTTP URL. It does not install, launch,
or configure browsers, so callers can pass that URL to whichever separately
supplied HTTP client or browser controller fits their workflow.

## Copy-paste workflow

Request JSON when a shell needs to extract the URL without a TOON decoder:

```sh
result="$(htmlview serve ./report.html --json)"
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
htmlview stop "$session" --json
```

## Validated controllers

Release validation passes a CLI-returned URL through two independently
installed controllers:

- `npm run validate:interoperability` uses Playwright Chromium.
- `npm run validate:browser-use` uses the separately installed `browser-use`
  executable and its default connection to a running Chrome instance.

Neither controller is imported by the runtime or included in the published
package.

## Agent Skill evaluation

Version one does not ship an Agent Skill. The home view and command-specific
help already expose the complete four-operation workflow, while a generated
skill would duplicate that static guidance and would need installation-aware
invocation rules. Revisit a generated skill only if observed workflows need
more guidance than `htmlview`, `htmlview serve --help`, and `htmlview stop
--help` provide. Ambient session hooks remain out of scope.
