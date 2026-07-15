#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
state_parent="$(mktemp -d)"
session_name="htmlview-interoperability-$$"
entry="$repo_root/validation/browser-origin/fixtures/root/pages/report space ü.html"
root="$repo_root/validation/browser-origin/fixtures/root"
export HTMLVIEW_STATE_DIR="$state_parent/state"
export HTMLVIEW_IDLE_MS="50"

cleanup() {
  agent-browser --session "$session_name" close >/dev/null 2>&1 || true
  node "$repo_root/dist/cli.js" stop --all --json >/dev/null 2>&1 || true
  for _ in {1..100}; do
    if [[ ! -e "$HTMLVIEW_STATE_DIR/supervisor.json" ]]; then break; fi
    sleep 0.02
  done
  rm -rf "$state_parent"
}
trap cleanup EXIT

serve_result="$(node "$repo_root/dist/cli.js" serve "$entry" --root "$root" --json)"
url="$(node -e 'const value=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(value.session.url)' <<<"$serve_result")"

agent-browser --session "$session_name" open "$url" >/dev/null
agent-browser --session "$session_name" wait --fn 'window.fixtureResults !== undefined' >/dev/null
actual="$(agent-browser --session "$session_name" eval 'JSON.stringify(window.fixtureResults)')"

node -e '
let actual = JSON.parse(process.argv[1]);
if (typeof actual === "string") actual = JSON.parse(actual);
const expected = {
  protocol: "http:",
  rootStyle: "root-style-loaded",
  module: "module-loaded",
  fetch: 200,
  unreferenced: "in-root-unreferenced-readable\n",
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(JSON.stringify({ expected, actual }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ controller: "agent-browser", url: process.argv[2], result: actual }, null, 2));
' "$actual" "$url"
