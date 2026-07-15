#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
state_parent="$(mktemp -d)"
entry="$repo_root/validation/browser-origin/fixtures/root/pages/report space ü.html"
root="$repo_root/validation/browser-origin/fixtures/root"
export HTMLVIEW_STATE_DIR="$state_parent/state"
export HTMLVIEW_IDLE_MS="1000"

cleanup() {
  node "$repo_root/dist/cli.js" stop --all --json >/dev/null 2>&1 || true
  for _ in {1..100}; do
    if [[ ! -S "$HTMLVIEW_STATE_DIR/control.sock" ]]; then break; fi
    sleep 0.02
  done
  rm -rf "$state_parent"
}
trap cleanup EXIT

serve_result="$(node "$repo_root/dist/cli.js" serve "$entry" --root "$root" --json)"
export HTMLVIEW_URL
HTMLVIEW_URL="$(node -e 'const value=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(value.session.url)' <<<"$serve_result")"

if ! browser-use <<'PY'
import json
import os
import time

expected = {
    "protocol": "http:",
    "rootStyle": "root-style-loaded",
    "module": "module-loaded",
    "fetch": 200,
    "unreferenced": "in-root-unreferenced-readable\n",
}

target_id = new_tab(os.environ["HTMLVIEW_URL"])
try:
    wait_for_load()
    capture_screenshot()
    deadline = time.monotonic() + 10
    actual = None
    while time.monotonic() < deadline:
        encoded = js("JSON.stringify(window.fixtureResults ?? null)")
        actual = json.loads(encoded) if isinstance(encoded, str) else encoded
        if actual is not None:
            break
        time.sleep(0.1)
    if actual != expected:
        raise AssertionError(json.dumps({"expected": expected, "actual": actual}, ensure_ascii=False))
    print(json.dumps({"controller": "browser-use", "url": os.environ["HTMLVIEW_URL"], "result": actual}, ensure_ascii=False))
finally:
    cdp("Target.closeTarget", targetId=target_id)
PY
then
  browser-use --doctor >&2 || true
  exit 1
fi
