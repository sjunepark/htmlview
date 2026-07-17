import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [binary, fixture] = process.argv.slice(2);
const state = process.env.HTMLVIEW_STATE_DIR;

if (binary === undefined || fixture === undefined || state === undefined) {
  process.stderr.write(
    "Usage: node installed-workflow.mjs <htmlview-binary> <fixture-directory>\n",
  );
  process.exit(2);
}

const entry = path.join(fixture, "report.html");
const controlSocket = path.join(state, "control.sock");
const supervisorLock = path.join(state, "supervisor.lock");
const environment = { ...process.env };
delete environment.NO_COLOR;
delete environment.FORCE_COLOR;

async function installed(args) {
  return execute(binary, args, {
    cwd: fixture,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
}

function loopbackRequest(url, { pathname, headers = {} } = {}) {
  const target = new URL(url);
  if (pathname !== undefined) target.pathname = pathname;
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { host: target.host, ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    operation.setTimeout(5_000, () =>
      operation.destroy(new Error(`HTTP request for ${target.host} timed out`)),
    );
    operation.on("error", reject);
    operation.end();
  });
}

async function observedRevision(reviewUrl, previous) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await loopbackRequest(reviewUrl, {
      pathname: "/.htmlview/api/entry",
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    assert.equal(response.status, 200);
    const observation = JSON.parse(response.body.toString("utf8")).entry;
    if (
      observation?.availability === "available" &&
      /^sha256:[0-9a-f]{64}$/.test(observation.revision) &&
      observation.revision !== previous
    )
      return observation.revision;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "Installed review observer did not report the entry revision",
  );
}

async function waitForSupervisorExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [socketPresent, lockPresent] = await Promise.all(
      [controlSocket, supervisorLock].map((candidate) =>
        access(candidate)
          .then(() => true)
          .catch(() => false),
      ),
    );
    let processPresent;
    try {
      process.kill(pid, 0);
      processPresent = true;
    } catch {
      processPresent = false;
    }
    if (!socketPresent && !lockPresent && !processPresent) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Installed supervisor retained its process, socket, or lock after stop --all",
  );
}

async function stopSupervisor(pid) {
  let stopFailure;
  try {
    await installed(["stop", "--all", "--json"]);
  } catch (error) {
    stopFailure = error;
  }

  let cleanupFailure;
  if (pid !== undefined) {
    try {
      await waitForSupervisorExit(pid);
    } catch (error) {
      cleanupFailure = error;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process may have exited between the failed wait and termination.
      }
      await waitForSupervisorExit(pid);
    }
  }

  if (stopFailure !== undefined) throw stopFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

let supervisorPid;
let result;
try {
  const initial = await readFile(entry);
  const served = JSON.parse(
    (await installed(["serve", "report.html", "--json"])).stdout,
  );
  supervisorPid = JSON.parse(
    await readFile(path.join(supervisorLock, "owner.json"), "utf8"),
  ).pid;
  assert.equal(
    new URL(served.session.url).hostname.endsWith(".localhost"),
    true,
  );
  assert.equal(
    served.grant.root,
    await import("node:fs/promises").then(({ realpath }) => realpath(fixture)),
  );

  const initialRaw = await loopbackRequest(served.session.url);
  assert.equal(initialRaw.status, 200);
  assert.deepEqual(initialRaw.body, initial);

  const review = JSON.parse(
    (await installed(["review", served.session.id, "--json"])).stdout,
  );
  assert.equal(review.review.status, "ready");
  assert.equal(review.session.id, served.session.id);
  assert.equal(review.session.url, served.session.url);
  assert.equal(review.fidelity, "instrumented_review");
  assert.notEqual(
    new URL(review.review.url).origin,
    new URL(served.session.url).origin,
  );

  const shell = await loopbackRequest(review.review.url);
  assert.equal(shell.status, 200);
  assert.match(shell.headers["content-type"], /^text\/html; charset=utf-8$/);
  assert.match(shell.body.toString("utf8"), /<title>htmlview review<\/title>/);

  const firstRevision = await observedRevision(review.review.url);
  const changed = Buffer.concat([
    initial,
    Buffer.from("\n<!-- installed review observer -->\n"),
  ]);
  await writeFile(entry, changed);
  const changedRevision = await observedRevision(
    review.review.url,
    firstRevision,
  );
  assert.notEqual(changedRevision, firstRevision);

  const changedRaw = await loopbackRequest(served.session.url);
  assert.equal(changedRaw.status, 200);
  assert.deepEqual(changedRaw.body, changed);

  const feedback = JSON.parse(
    (await installed(["feedback", review.review.id, "--json"])).stdout,
  );
  assert.deepEqual(feedback.review, {
    id: review.review.id,
    status: "ready",
  });
  assert.equal(feedback.cursor, 0);
  assert.equal(feedback.count, 0);
  assert.deepEqual(feedback.feedback, []);

  result = {
    raw: "passed",
    review: "passed",
    observer: "passed",
    feedback_read: "passed",
    cleanup: "passed",
  };
} finally {
  await stopSupervisor(supervisorPid);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
