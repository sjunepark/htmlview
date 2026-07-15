import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { entryPath, fixtureRoot } from "../browser-origin/fixture.mjs";

const execute = promisify(execFile);

test("a separate browser controller consumes the URL returned by htmlview", async ({
  page,
}) => {
  const stateParent = await mkdtemp(
    path.join(tmpdir(), "htmlview-playwright-interoperability-"),
  );
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "50",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  const cli = path.resolve("dist/cli.js");
  try {
    const served = await execute(
      process.execPath,
      [cli, "serve", entryPath, "--root", fixtureRoot, "--json"],
      { env: environment },
    );
    const result = JSON.parse(served.stdout);
    const session = result.session;
    expect(served.stderr).toBe("");
    expect(await fetch(session.url).then((response) => response.status)).toBe(
      200,
    );

    await page.goto(session.url);
    await page.waitForFunction(() => window.fixtureResults !== undefined);
    expect(await page.evaluate(() => window.fixtureResults)).toEqual({
      protocol: "http:",
      rootStyle: "root-style-loaded",
      module: "module-loaded",
      fetch: 200,
      unreferenced: "in-root-unreferenced-readable\n",
    });
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    const discovery = path.join(stateParent, "state", "supervisor.json");
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const present = await readFile(discovery)
        .then(() => true)
        .catch(() => false);
      if (!present) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await rm(stateParent, { recursive: true, force: true });
  }
});
