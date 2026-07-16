import { spawnSync } from "node:child_process";
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
  standalone: ["serve", "examples/standalone.html", "--json"],
  stop: ["stop", "--all", "--json"],
};

const name = process.argv[2];
const args = commands[name];
if (args === undefined || process.argv.length !== 3) {
  process.stderr.write(
    `Usage: node scripts/run-example.mjs <${Object.keys(commands).join("|")}>\n`,
  );
  process.exitCode = 2;
} else {
  const user = process.getuid?.() ?? "user";
  const stateDirectory =
    process.env.HTMLVIEW_EXAMPLE_STATE_DIR ??
    path.join("/tmp", `htmlview-example-${user}`);
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, HTMLVIEW_STATE_DIR: stateDirectory },
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  try {
    process.stdout.write(
      `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`,
    );
  } catch {
    process.stdout.write(result.stdout);
  }
  process.exitCode = result.status ?? 1;
}
