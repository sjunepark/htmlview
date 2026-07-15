import { test, expect } from "@playwright/test";
import { resolveServingGrant } from "../../dist/serving/grant.js";
import { startStaticServer } from "../../dist/serving/http.js";
import { entryPath, fixtureRoot } from "./fixture.mjs";

test("the htmlview raw handler loads the complete fixture in a generic browser", async ({
  page,
}) => {
  const grant = await resolveServingGrant(entryPath, { root: fixtureRoot });
  const server = await startStaticServer(grant, {
    hostname: "h-htmlview-playwright.localhost",
  });
  try {
    await page.goto(server.url);
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
