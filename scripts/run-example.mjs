import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const commands = {
  list: ["--fields", "entry,root", "--json"],
  relative: ["serve", "examples/relative/index.html", "--json"],
  root: [
    "serve",
    "examples/project-root/public/pages/report.html",
    "--root",
    "examples/project-root",
    "--json",
  ],
  standalone: ["serve", "examples/standalone/index.html", "--json"],
  stop: ["stop", "--all", "--json"],
};
const names = [...Object.keys(commands), "review", "feedback"];

const name = process.argv[2];
const args = commands[name];
if (
  !names.includes(name) ||
  (args === undefined && name !== "review" && name !== "feedback") ||
  (name !== "feedback" && process.argv.length !== 3)
) {
  process.stderr.write(
    `Usage: node scripts/run-example.mjs <${names.filter((candidate) => candidate !== "feedback").join("|")}>\n` +
      "       node scripts/run-example.mjs feedback [feedback-options] <review>\n",
  );
  process.exitCode = 2;
} else {
  const user = process.getuid?.() ?? "user";
  const checkout = createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 12);
  const stateDirectory =
    process.env.HTMLVIEW_EXAMPLE_STATE_DIR ??
    path.join(tmpdir(), `htmlview-example-${user}-${checkout}`);
  const run = (commandArgs) => {
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", ...commandArgs],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, HTMLVIEW_STATE_DIR: stateDirectory },
        stdio: ["inherit", "pipe", "inherit"],
      },
    );
    if (result.error !== undefined) throw result.error;
    return result;
  };
  let result;
  if (name === "review") {
    const served = run(commands.relative);
    if (served.status !== 0) result = served;
    else {
      let session;
      try {
        const value = JSON.parse(served.stdout);
        if (typeof value?.session?.id !== "string") throw new TypeError();
        session = value.session.id;
      } catch {
        process.stderr.write(
          "The relative example did not return a valid serving session.\n",
        );
        process.exitCode = 1;
      }
      if (session !== undefined) result = run(["review", session, "--json"]);
    }
  } else if (name === "feedback")
    result = run(["feedback", ...process.argv.slice(3)]);
  else result = run(args);
  if (result === undefined) process.exitCode ??= 1;
  else {
    try {
      process.stdout.write(
        `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`,
      );
    } catch {
      process.stdout.write(result.stdout);
    }
    process.exitCode = result.status ?? 1;
  }
}
