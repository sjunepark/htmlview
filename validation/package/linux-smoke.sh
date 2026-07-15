#!/usr/bin/env bash
set -euo pipefail

export HTMLVIEW_STATE_DIR="/tmp/htmlview-state"
export HTMLVIEW_IDLE_MS="1000"
tarball=(/artifacts/*.tgz)

npm install --global "${tarball[0]}" >/dev/null
node -e 'const {execFileSync}=require("child_process"); const value=JSON.parse(execFileSync("htmlview",["--version","--json"],{encoding:"utf8"})); if(value.version!==process.env.EXPECTED_VERSION) process.exit(1)'

mkdir /tmp/htmlview-fixture
printf '<!doctype html><p>linux package</p>' >/tmp/htmlview-fixture/report.html
cd /tmp/htmlview-fixture
result="$(htmlview serve report.html --json)"
url="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.session.url)' "$result")"
node -e '
const http=require("http");
const url=new URL(process.argv[1]);
http.get({hostname:"127.0.0.1",port:url.port,path:url.pathname,headers:{host:url.host}}, response => {
  const chunks=[];
  response.on("data", chunk => chunks.push(chunk));
  response.on("end", () => {
    if (response.statusCode !== 200 || Buffer.concat(chunks).toString() !== "<!doctype html><p>linux package</p>") process.exit(1);
  });
}).on("error", error => { console.error(error); process.exit(1); });
' "$url"
htmlview stop --all --json >/dev/null
sleep 0.2

npm install --global "${tarball[0]}" >/dev/null
htmlview --version --json >/dev/null
npm uninstall --global @sejunpark/htmlview >/dev/null
hash -r
if command -v htmlview >/dev/null; then
  echo "htmlview remained installed" >&2
  exit 1
fi
printf '{"platform":"linux","version":"%s","install":"passed","reinstall":"passed","uninstall":"passed"}\n' "$EXPECTED_VERSION"
