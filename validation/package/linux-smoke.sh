#!/usr/bin/env bash
set -euo pipefail

export HTMLVIEW_STATE_DIR="/tmp/htmlview-state"
export HTMLVIEW_IDLE_MS="1000"
tarball=(/artifacts/*.tgz)

npm install --global "${tarball[0]}" >/dev/null
node -e 'const {execFileSync}=require("child_process"); const value=execFileSync("htmlview",["--version"],{encoding:"utf8"}); if(value!==`htmlview v${process.env.EXPECTED_VERSION}\n`) process.exit(1)'

mkdir /tmp/htmlview-fixture
printf '<!doctype html><p>linux package</p>' >/tmp/htmlview-fixture/report.html
cd /tmp/htmlview-fixture
result="$(htmlview serve report.html --json)"
supervisor_pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.HTMLVIEW_STATE_DIR+"/supervisor.lock/owner.json","utf8")).pid))')"
url="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.session.url)' "$result")"
node -e '
const http=require("http");
const url=new URL(process.argv[1]);
const request=http.get({hostname:"127.0.0.1",port:url.port,path:url.pathname,headers:{host:url.host}}, response => {
  const chunks=[];
  response.on("data", chunk => chunks.push(chunk));
  response.on("end", () => {
    if (response.statusCode !== 200 || Buffer.concat(chunks).toString() !== "<!doctype html><p>linux package</p>") process.exit(1);
  });
});
request.setTimeout(5_000, () => request.destroy(new Error("HTTP smoke test timed out")));
request.on("error", error => { console.error(error); process.exit(1); });
' "$url"
htmlview stop --all --json >/dev/null
for _ in $(seq 1 100); do
  if ! kill -0 "$supervisor_pid" 2>/dev/null &&
    [[ ! -e "$HTMLVIEW_STATE_DIR/control.sock" ]] &&
    [[ ! -e "$HTMLVIEW_STATE_DIR/supervisor.lock" ]]; then
    break
  fi
  sleep 0.02
done
if kill -0 "$supervisor_pid" 2>/dev/null ||
  [[ -e "$HTMLVIEW_STATE_DIR/control.sock" ]] ||
  [[ -e "$HTMLVIEW_STATE_DIR/supervisor.lock" ]]; then
  echo "htmlview supervisor remained after stop --all" >&2
  exit 1
fi

npm install --global "${tarball[0]}" >/dev/null
htmlview --version >/dev/null
npm uninstall --global @sejunpark/htmlview >/dev/null
hash -r
if command -v htmlview >/dev/null; then
  echo "htmlview remained installed" >&2
  exit 1
fi
printf '{"platform":"linux","version":"%s","install":"passed","reinstall":"passed","uninstall":"passed"}\n' "$EXPECTED_VERSION"
