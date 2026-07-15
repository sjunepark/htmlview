#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
temporary="$(mktemp -d)"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT

cd "$repo_root"
npm run build --silent
npm pack --pack-destination "$temporary" --silent >/dev/null
version="$(node -p 'require("./package.json").version')"

docker run --rm \
  --env "EXPECTED_VERSION=$version" \
  --volume "$temporary:/artifacts:ro" \
  --volume "$repo_root/validation/package/linux-smoke.sh:/linux-smoke.sh:ro" \
  node:22-bookworm bash /linux-smoke.sh
