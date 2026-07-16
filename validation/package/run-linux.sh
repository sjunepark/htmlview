#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
temporary="$(mktemp -d)"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT

source_copy="$temporary/source"
artifacts="$temporary/artifacts"
export HTMLVIEW_LINUX_REPO_ROOT="$repo_root"
export HTMLVIEW_LINUX_SOURCE_COPY="$source_copy"

node --input-type=module <<'NODE'
import { cp, mkdir, symlink } from "node:fs/promises";
import path from "node:path";

const repository = process.env.HTMLVIEW_LINUX_REPO_ROOT;
const source = process.env.HTMLVIEW_LINUX_SOURCE_COPY;
await cp(repository, source, {
  recursive: true,
  filter(candidate) {
    const first = path.relative(repository, candidate).split(path.sep)[0];
    return ![
      ".git",
      "coverage",
      "dist",
      "node_modules",
      "playwright-report",
      "test-results",
    ].includes(first);
  },
});
await mkdir(path.dirname(source), { recursive: true });
await symlink(path.join(repository, "node_modules"), path.join(source, "node_modules"));
NODE

mkdir "$artifacts"
cd "$source_copy"
pnpm pack --pack-destination "$artifacts" --silent >/dev/null
version="$(node -p 'require("./package.json").version')"

docker run --rm \
  --env "EXPECTED_VERSION=$version" \
  --volume "$artifacts:/artifacts:ro" \
  --volume "$repo_root/validation/package/linux-smoke.sh:/linux-smoke.sh:ro" \
  node:22-bookworm bash /linux-smoke.sh
