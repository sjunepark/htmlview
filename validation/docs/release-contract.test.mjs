import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("Release Please owns one root npm package", async () => {
  const [packageText, configText, manifestText] = await Promise.all([
    read("package.json"),
    read("release-please-config.json"),
    read(".release-please-manifest.json"),
  ]);
  const packageJson = JSON.parse(packageText);
  const config = JSON.parse(configText);
  const manifest = JSON.parse(manifestText);

  assert.equal(packageJson.name, "@sjunepark/htmlview");
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/sjunepark/htmlview.git",
  );
  assert.deepEqual(Object.keys(config.packages), ["."]);
  assert.deepEqual(config.packages["."], {
    "release-type": "node",
    "initial-version": "0.1.0",
    "include-component-in-tag": false,
  });
  assert.deepEqual(manifest, {});
});

test("release workflow publishes only the Release Please output through OIDC", async () => {
  const workflow = await read(".github/workflows/release-please.yml");

  assert.match(workflow, /googleapis\/release-please-action@[0-9a-f]{40} # v4/);
  assert.match(workflow, /group: release-please-main/);
  assert.match(workflow, /target-branch: main/);
  assert.match(workflow, /gh workflow run ci\.yml --ref "\$release_branch"/);
  assert.match(workflow, /release-created == 'true'/);
  assert.match(
    workflow,
    /ref: \$\{\{ needs\.release-please\.outputs\.release-sha \}\}/,
  );
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /node scripts\/pack-release\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40} # v4/);
  assert.match(
    workflow,
    /name: npm-package-\$\{\{ needs\.release-please\.outputs\.release-version \}\}/,
  );
  assert.match(workflow, /dist\.integrity/);
  assert.match(workflow, /npm publish "\$RELEASE_TARBALL" --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("release operations preserve the external browser gate and bootstrap boundary", async () => {
  const [releasing, adr] = await Promise.all([
    read("docs/RELEASING.md"),
    read("docs/decisions/0010-automate-releases-with-release-please.md"),
  ]);

  assert.match(releasing, /pnpm run validate:browser-use/);
  assert.match(releasing, /@sjunepark\/htmlview@0\.1\.0/);
  assert.match(releasing, /organization or user: `sjunepark`/);
  assert.match(releasing, /workflow filename: `release-please\.yml`/);
  assert.match(releasing, /allowed action: `npm publish`/);
  assert.match(
    releasing,
    /gh run download <run-id> --name npm-package-0\.1\.0/,
  );
  assert.match(releasing, /Do not rebuild the bootstrap artifact/);
  assert.match(adr, /No long-lived npm write token is stored/);
  assert.match(adr, /interactive npm authentication\s+and 2FA/s);
});
