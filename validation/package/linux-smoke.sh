#!/usr/bin/env bash
set -euo pipefail

export HTMLVIEW_STATE_DIR="/tmp/htmlview-state"
export HTMLVIEW_IDLE_MS="1000"
tarball=(/artifacts/*.tgz)

npm install --global "${tarball[0]}" >/dev/null
node -e 'const {execFileSync}=require("child_process"); const value=execFileSync("htmlview",["--version"],{encoding:"utf8"}); if(value!==`htmlview v${process.env.EXPECTED_VERSION}\n`) process.exit(1)'

mkdir /tmp/htmlview-fixture
printf '<!doctype html><p>linux package</p>' >/tmp/htmlview-fixture/report.html
workflow="$(node /installed-workflow.mjs "$(command -v htmlview)" /tmp/htmlview-fixture)"
node -e '
const assert=require("assert/strict");
assert.deepEqual(JSON.parse(process.argv[1]), {
  raw:"passed", review:"passed", observer:"passed", feedback_read:"passed", cleanup:"passed"
});
' "$workflow"

npm install --global "${tarball[0]}" >/dev/null
htmlview --version >/dev/null
npm uninstall --global @sejunpark/htmlview >/dev/null
hash -r
if command -v htmlview >/dev/null; then
  echo "htmlview remained installed" >&2
  exit 1
fi
printf '{"platform":"linux","version":"%s","install":"passed","review":"passed","observer":"passed","feedback_read":"passed","reinstall":"passed","uninstall":"passed"}\n' "$EXPECTED_VERSION"
