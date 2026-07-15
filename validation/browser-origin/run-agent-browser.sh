#!/usr/bin/env bash
set -euo pipefail

ready_file="$(mktemp)"
session="htmlview-origin-validation-$$"
node validation/browser-origin/serve-fixture.mjs "$ready_file" &
server_pid=$!

cleanup() {
  agent-browser --session "$session" close >/dev/null 2>&1 || true
  kill "$server_pid" >/dev/null 2>&1 || true
  rm -f "$ready_file"
}
trap cleanup EXIT

for _ in {1..100}; do
  if [[ -s "$ready_file" ]]; then break; fi
  sleep 0.05
done

url="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).url)' "$ready_file")"
agent-browser --session "$session" open "$url" >/dev/null
agent-browser --session "$session" wait --fn 'window.fixtureResults !== undefined' >/dev/null
actual="$(agent-browser --session "$session" eval 'JSON.stringify(window.fixtureResults)')"

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
