import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { entryPath, fixtureRoot, listenFixture } from "./fixture.mjs";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const state = await mkdtemp(path.join(tmpdir(), "htmlview-browser-origin-"));
const environment = {
  ...process.env,
  HTMLVIEW_IDLE_MS: "500",
  HTMLVIEW_STATE_DIR: state,
};

async function startStaticServer() {
  const { stdout } = await execute(
    process.execPath,
    [cli, "serve", entryPath, "--root", fixtureRoot, "--json"],
    { env: environment },
  );
  const result = JSON.parse(stdout);
  return {
    url: result.session.url,
    close: () =>
      execute(process.execPath, [cli, "stop", result.session.id, "--json"], {
        env: environment,
      }),
  };
}

test.afterAll(async () => {
  await execute(process.execPath, [cli, "stop", "--all", "--json"], {
    env: environment,
  }).catch(() => undefined);
  await rm(state, { recursive: true, force: true });
});

test("the htmlview raw handler loads the complete fixture in a generic browser", async ({
  page,
}) => {
  const server = await startStaticServer();
  try {
    const navigation = await page.goto(server.url);
    expect(navigation?.headers()["cache-control"]).toBe("no-cache");
    await page.waitForFunction(() => window.fixtureResults !== undefined);
    expect(await page.evaluate(() => window.fixtureResults)).toEqual({
      protocol: "http:",
      rootStyle: "root-style-loaded",
      module: "module-loaded",
      fetch: 200,
      unreferenced: "in-root-unreferenced-readable\n",
    });
  } finally {
    await server.close();
  }
});

test("a foreign page cannot read the raw origin through CORS", async ({
  page,
}) => {
  const server = await startStaticServer();
  const foreign = await listenFixture({
    urlHost: "foreign-htmlview.localhost",
  });
  try {
    await page.goto(`${foreign.origin}/state.html`);
    const outcome = await page.evaluate(
      (url) =>
        fetch(url)
          .then(() => "readable")
          .catch((error) => `blocked:${error.name}`),
      server.url,
    );
    expect(outcome).toBe("blocked:TypeError");
  } finally {
    await Promise.all([server.close(), foreign.close()]);
  }
});
