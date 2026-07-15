import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { encodedEntryPath, entryPath, listenFixture } from "./fixture.mjs";

test.setTimeout(60_000);

async function readFixture(page, url) {
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(
    () => window.fixtureResults !== undefined,
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(() => window.fixtureResults);
}

test("file navigation differs materially from loopback HTTP", async ({
  browser,
}) => {
  const server = await listenFixture();
  const context = await browser.newContext();
  const filePage = await context.newPage();
  const httpPage = await context.newPage();
  try {
    const fileResult = await readFixture(
      filePage,
      pathToFileURL(entryPath).href,
    );
    const httpResult = await readFixture(
      httpPage,
      `${server.origin}${encodedEntryPath()}`,
    );

    expect(httpResult).toEqual({
      protocol: "http:",
      rootStyle: "root-style-loaded",
      module: "module-loaded",
      fetch: 200,
      unreferenced: "in-root-unreferenced-readable\n",
    });
    expect(fileResult).toEqual({
      protocol: "file:",
      rootStyle: "",
      module: "error:TypeError",
      fetch: "error:TypeError",
      unreferenced: "error:TypeError",
    });

    const response = await context.request.get(
      `${server.origin}/pages/module%20%C3%BC.js`,
    );
    expect(response.headers()["content-type"]).toBe(
      "text/javascript; charset=utf-8",
    );
  } finally {
    await context.close();
    await server.close();
  }
});

test("same numeric host shares cookies across concurrent ports", async ({
  browser,
}) => {
  const first = await listenFixture({ label: "first" });
  const second = await listenFixture({ label: "second" });
  const unrelated = await listenFixture({ label: "unrelated" });
  const context = await browser.newContext();
  try {
    const firstPage = await context.newPage();
    await firstPage.goto(`${first.origin}/state.html`);
    await firstPage.evaluate(() => {
      document.cookie = "overlap=from-first; SameSite=Lax; Path=/";
    });

    for (const service of [second, unrelated]) {
      const page = await context.newPage();
      await page.goto(`${service.origin}/state.html`);
      expect(await page.evaluate(() => document.cookie)).toContain(
        "overlap=from-first",
      );
    }
  } finally {
    await context.close();
    await Promise.all([first.close(), second.close(), unrelated.close()]);
  }
});

test("exact origin reuse revives storage, cache, and service worker", async ({
  browser,
}) => {
  const first = await listenFixture({
    urlHost: "reused.localhost",
    label: "prior-session",
  });
  const reusedPort = first.port;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${first.origin}/state.html`);
    await page.evaluate(() => {
      document.cookie = "lifetime=prior; SameSite=Lax; Path=/";
      localStorage.setItem("lifetime", "prior-session");
    });
    expect(
      await page.evaluate(() =>
        fetch("/cache.txt").then((response) => response.text()),
      ),
    ).toBe("prior-session");
    await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await first.close();

    const later = await listenFixture({
      urlHost: "reused.localhost",
      port: reusedPort,
      label: "later-session",
    });
    try {
      await page.goto(`${later.origin}/state.html`);
      expect(await page.evaluate(() => document.cookie)).toContain(
        "lifetime=prior",
      );
      expect(await page.evaluate(() => localStorage.getItem("lifetime"))).toBe(
        "prior-session",
      );
      expect(
        await page.evaluate(() =>
          fetch("/cache.txt").then((response) => response.text()),
        ),
      ).toBe("prior-session");
      expect(
        await page.evaluate(() =>
          fetch("/sw-probe").then((response) => response.text()),
        ),
      ).toBe("prior-session");
      expect(later.hits.get("/cache.txt") ?? 0).toBe(0);
      expect(later.hits.get("/sw-probe") ?? 0).toBe(0);
    } finally {
      await later.close();
    }
  } finally {
    await context.close();
  }
});

test("a fresh localhost name isolates all retained state", async ({
  browser,
}) => {
  const prior = await listenFixture({
    urlHost: "prior.localhost",
    label: "prior-host",
  });
  let priorClosed = false;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${prior.origin}/state.html`);
    await page.evaluate(() => {
      document.cookie = "hostscope=prior; SameSite=Lax; Path=/";
      document.cookie =
        "domainwide=prior; Domain=localhost; SameSite=Lax; Path=/";
      localStorage.setItem("hostscope", "prior-host");
    });
    await page.evaluate(() =>
      fetch("/cache.txt").then((response) => response.text()),
    );
    await page.evaluate(() => navigator.serviceWorker.register("/sw.js"));
    await page.evaluate(() => navigator.serviceWorker.ready);
    await prior.close();
    priorClosed = true;

    const fresh = await listenFixture({
      urlHost: "fresh.localhost",
      port: prior.port,
      label: "fresh-host",
    });
    try {
      await page.goto(`${fresh.origin}/state.html`);
      expect(await page.evaluate(() => document.cookie)).not.toContain(
        "hostscope=prior",
      );
      expect(await page.evaluate(() => document.cookie)).not.toContain(
        "domainwide=prior",
      );
      expect(
        await page.evaluate(() => localStorage.getItem("hostscope")),
      ).toBeNull();
      expect(
        await page.evaluate(() =>
          fetch("/cache.txt").then((response) => response.text()),
        ),
      ).toBe("fresh-host");
      expect(
        await page.evaluate(() =>
          fetch("/sw-probe").then((response) => response.text()),
        ),
      ).toBe("network:fresh-host");
      expect(fresh.hits.get("/cache.txt")).toBe(1);
      expect(fresh.hits.get("/sw-probe")).toBe(1);
    } finally {
      await fresh.close();
    }
  } finally {
    await context.close();
    if (!priorClosed) await prior.close();
  }
});
