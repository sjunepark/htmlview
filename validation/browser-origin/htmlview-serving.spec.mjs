import { test, expect } from "@playwright/test";
import { resolveServingGrant } from "../../dist/serving/grant.js";
import { startStaticServer } from "../../dist/serving/http.js";
import { entryPath, fixtureRoot, listenFixture } from "./fixture.mjs";

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

test("a foreign page cannot read the raw origin through CORS", async ({
  page,
}) => {
  const grant = await resolveServingGrant(entryPath, { root: fixtureRoot });
  const server = await startStaticServer(grant, {
    hostname: "h-htmlview-cors.localhost",
  });
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
