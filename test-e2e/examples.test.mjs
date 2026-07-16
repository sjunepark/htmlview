import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const repository = process.cwd();
const examples = path.join(repository, "examples");

let temporary;
let environment;

function example(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", [`example:${command}`], {
      cwd: repository,
      env: {
        ...process.env,
        HTMLVIEW_EXAMPLE_STATE_DIR: environment.HTMLVIEW_STATE_DIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

async function serve(command) {
  const result = await example(command);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

async function assertServed(url, source, contentType) {
  const response = await fetch(url);
  assert.equal(response.status, 200, url);
  assert.equal(response.headers.get("content-type"), contentType, url);
  assert.equal(await response.text(), await readFile(source, "utf8"), url);
}

before(async () => {
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), "hv-ex-")));
  environment = {
    HTMLVIEW_STATE_DIR: path.join(temporary, "state"),
  };
});

after(async () => {
  if (environment !== undefined) await example("stop").catch(() => undefined);
  if (temporary !== undefined)
    await rm(temporary, { recursive: true, force: true });
});

test("committed examples exercise standalone, relative, and explicit-root serving", async () => {
  const standalone = await serve("standalone");
  assert.equal(
    standalone.grant.root,
    await realpath(path.join(examples, "standalone")),
  );
  await assertServed(
    standalone.session.url,
    path.join(examples, "standalone", "index.html"),
    "text/html; charset=utf-8",
  );

  const relativeRoot = path.join(examples, "relative");
  const relative = await serve("relative");
  assert.equal(relative.grant.root, await realpath(relativeRoot));
  await Promise.all([
    assertServed(
      relative.session.url,
      path.join(relativeRoot, "index.html"),
      "text/html; charset=utf-8",
    ),
    assertServed(
      new URL("assets/site.css", relative.session.url),
      path.join(relativeRoot, "assets", "site.css"),
      "text/css; charset=utf-8",
    ),
    assertServed(
      new URL("assets/mark.svg", relative.session.url),
      path.join(relativeRoot, "assets", "mark.svg"),
      "image/svg+xml",
    ),
    assertServed(
      new URL("scripts/app.js", relative.session.url),
      path.join(relativeRoot, "scripts", "app.js"),
      "text/javascript; charset=utf-8",
    ),
    assertServed(
      new URL("data/message.json", relative.session.url),
      path.join(relativeRoot, "data", "message.json"),
      "application/json; charset=utf-8",
    ),
  ]);

  const projectRoot = path.join(examples, "project-root");
  const rooted = await serve("root");
  assert.equal(rooted.grant.root, await realpath(projectRoot));
  assert.equal(
    new URL(rooted.session.url).pathname,
    "/public/pages/report.html",
  );
  await Promise.all([
    assertServed(
      rooted.session.url,
      path.join(projectRoot, "public", "pages", "report.html"),
      "text/html; charset=utf-8",
    ),
    assertServed(
      new URL("/assets/report.css", rooted.session.url),
      path.join(projectRoot, "assets", "report.css"),
      "text/css; charset=utf-8",
    ),
    assertServed(
      new URL("/assets/report.js", rooted.session.url),
      path.join(projectRoot, "assets", "report.js"),
      "text/javascript; charset=utf-8",
    ),
    assertServed(
      new URL("/data/status.json", rooted.session.url),
      path.join(projectRoot, "data", "status.json"),
      "application/json; charset=utf-8",
    ),
  ]);

  const listed = await example("list");
  assert.equal(listed.code, 0, listed.stdout || listed.stderr);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.count, 3);
  assert.deepEqual(
    listing.sessions
      .map(({ entry, root }) => ({ entry, root }))
      .sort((left, right) => left.entry.localeCompare(right.entry)),
    [
      {
        entry: await realpath(
          path.join(projectRoot, "public/pages/report.html"),
        ),
        root: await realpath(projectRoot),
      },
      {
        entry: await realpath(path.join(relativeRoot, "index.html")),
        root: await realpath(relativeRoot),
      },
      {
        entry: await realpath(path.join(examples, "standalone", "index.html")),
        root: await realpath(path.join(examples, "standalone")),
      },
    ].sort((left, right) => left.entry.localeCompare(right.entry)),
  );

  const stopped = await example("stop");
  assert.equal(stopped.code, 0, stopped.stdout || stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout).stop, {
    scope: "all",
    stopped: 3,
    status: "stopped",
  });
});
