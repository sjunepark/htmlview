import { homedir } from "node:os";
import path from "node:path";
import type {
  JsonObject,
  OptionalSessionField,
  SessionSummary,
} from "./contracts.js";
import { errorResult } from "./contracts.js";
import { parseCommand } from "./command.js";
import { serialize } from "./output.js";
import { OperationError, type CommandService } from "./service.js";

export interface AppContext {
  readonly executablePath: string;
  readonly service: CommandService;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

function displayPath(value: string): string {
  const home = homedir();
  return value === home
    ? "~"
    : value.startsWith(`${home}${path.sep}`)
      ? `~${value.slice(home.length)}`
      : value;
}

function homeHelp(json: boolean): string[] {
  const suffix = json ? " --json" : "";
  return [`Run \`htmlview serve <entry.html>${suffix}\``];
}

function homeResult(
  executablePath: string,
  sessions: readonly SessionSummary[],
  fields: readonly OptionalSessionField[],
  json: boolean,
): JsonObject {
  const selected = sessions.map((session) => {
    const row: SessionSummary = {
      id: session.id,
      status: session.status,
      url: session.url,
    };
    if (fields.includes("entry") && session.entry !== undefined)
      row.entry = session.entry;
    if (fields.includes("root") && session.root !== undefined)
      row.root = session.root;
    return row;
  });
  return {
    bin: displayPath(executablePath),
    description: "Serve local HTML through confined loopback HTTP",
    count: selected.length,
    sessions: selected,
    help:
      selected.length === 0
        ? homeHelp(json)
        : [
            `Run \`htmlview stop <session>${json ? " --json" : ""}\` to stop a session`,
          ],
  };
}

function topLevelHelp(): JsonObject {
  return {
    command: "htmlview",
    description: "Serve local HTML through confined loopback HTTP",
    usage: "htmlview [--fields entry,root] [--json]",
    flags: [
      { name: "--fields", value: "entry,root", default: "none" },
      { name: "--json", default: false },
      { name: "--help", default: false },
    ],
    examples: ["htmlview", "htmlview --fields entry,root", "htmlview --json"],
    commands: ["serve", "stop"],
  };
}

function serveHelp(): JsonObject {
  return {
    command: "htmlview serve",
    usage: "htmlview serve <entry.html> [--root <directory>] [--json]",
    arguments: [
      {
        name: "entry.html",
        required: true,
        description: "Existing .html or .htm entry file",
      },
    ],
    flags: [
      { name: "--root", value: "directory", default: "entry parent" },
      { name: "--json", default: false },
      { name: "--help", default: false },
    ],
    examples: [
      "htmlview serve ./report.html",
      "htmlview serve ./public/report.html --root .",
      "htmlview serve ./report.html --json",
    ],
  };
}

function stopHelp(): JsonObject {
  return {
    command: "htmlview stop",
    usage: "htmlview stop <session> [--json] | htmlview stop --all [--json]",
    arguments: [
      {
        name: "session",
        required: false,
        description: "Session identifier unless --all is used",
      },
    ],
    flags: [
      { name: "--all", default: false },
      { name: "--json", default: false },
      { name: "--help", default: false },
    ],
    examples: [
      "htmlview stop <session>",
      "htmlview stop --all",
      "htmlview stop <session> --json",
    ],
  };
}

export async function runApp(
  argv: readonly string[],
  context: AppContext,
): Promise<number> {
  const parsed = parseCommand(argv);
  if ("exitCode" in parsed) {
    const format = argv.includes("--json") ? "json" : "toon";
    context.stdout(serialize(parsed.result, format));
    return parsed.exitCode;
  }

  try {
    let result: JsonObject;
    if (parsed.help) {
      result =
        parsed.kind === "home"
          ? topLevelHelp()
          : parsed.kind === "serve"
            ? serveHelp()
            : stopHelp();
    } else if (parsed.kind === "home") {
      result = homeResult(
        context.executablePath,
        await context.service.listSessions(),
        parsed.fields,
        parsed.format === "json",
      );
    } else if (parsed.kind === "serve") {
      result = await context.service.serve(parsed.entry ?? "", parsed.root);
      result.help = [
        `Run \`htmlview stop <session>${parsed.format === "json" ? " --json" : ""}\` to stop this session`,
      ];
    } else {
      result = await context.service.stop(parsed.session, parsed.all);
    }
    context.stdout(serialize(result, parsed.format));
    return 0;
  } catch (error) {
    const format = parsed.format;
    const failure =
      error instanceof OperationError
        ? errorResult(error.code, error.message, {}, [...error.help])
        : errorResult(
            "runtime.internal",
            "htmlview could not complete the request",
          );
    context.stdout(serialize(failure, format));
    return 1;
  }
}
