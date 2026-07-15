import { homedir } from "node:os";
import path from "node:path";
import type { JsonObject } from "./contracts.js";
import { errorResult } from "./contracts.js";
import {
  isOperationalError,
  toPublicError,
  type OperationalError,
} from "./errors.js";
import { parseCommand, type ParsedCommand } from "./command.js";
import { serialize } from "./output.js";
import { type CommandService } from "./service.js";
import type {
  OptionalSessionField,
  SessionSummary,
} from "./supervisor/protocol.js";
import { htmlviewVersion } from "./version.js";

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
  const selected = sessions.map((session): SessionSummary => ({
    id: session.id,
    status: session.status,
    url: session.url,
    ...(fields.includes("entry") && session.entry !== undefined
      ? { entry: session.entry }
      : {}),
    ...(fields.includes("root") && session.root !== undefined
      ? { root: session.root }
      : {}),
  }));
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
    usage:
      "htmlview [--fields entry,root] [--json] | htmlview --version [--json]",
    flags: [
      { name: "--fields", value: "entry,root", default: "none" },
      { name: "--json", default: false },
      { name: "--version", default: false },
      { name: "--help", default: false },
    ],
    examples: [
      "htmlview",
      "htmlview --fields entry,root",
      "htmlview --version --json",
    ],
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

function runtimeHelp(error: OperationalError, parsed: ParsedCommand): string[] {
  const jsonSuffix = parsed.format === "json" ? " --json" : "";
  switch (error._tag) {
    case "PathError":
      return [
        `Run \`htmlview serve --help${jsonSuffix}\` to review entry and root requirements`,
      ];
    case "RuntimeStateError": {
      const command =
        parsed.kind === "serve"
          ? `htmlview serve <entry.html>${parsed.root === undefined ? "" : " --root <directory>"}${jsonSuffix}`
          : parsed.kind === "stop"
            ? `htmlview stop${parsed.all ? " --all" : " <session>"}${jsonSuffix}`
            : `htmlview${parsed.kind === "home" && parsed.fields.length > 0 ? ` --fields ${parsed.fields.join(",")}` : ""}${jsonSuffix}`;
      return [`Run \`${command}\` after correcting runtime-state permissions`];
    }
    case "ContentListenerError":
      if (parsed.kind !== "serve") return [];
      return [
        `Run \`htmlview serve <entry.html>${parsed.root === undefined ? "" : " --root <directory>"}${jsonSuffix}\` to retry`,
      ];
    case "ControlError":
      return error.code === "control.session_limit"
        ? [
            `Run \`htmlview stop <session>${jsonSuffix}\` before serving another entry`,
          ]
        : [];
    case "SupervisorError":
      if (error.code === "supervisor.incompatible")
        return [
          `Run \`htmlview stop --all${jsonSuffix}\` before retrying this command`,
        ];
      if (error.code === "supervisor.start_failed" && parsed.kind === "serve")
        return [
          `Run \`htmlview serve <entry.html>${parsed.root === undefined ? "" : " --root <directory>"}${jsonSuffix}\` to retry`,
        ];
      return [];
  }
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
    } else if (parsed.kind === "version") {
      result = { command: "htmlview", version: htmlviewVersion };
    } else if (parsed.kind === "home") {
      result = homeResult(
        context.executablePath,
        await context.service.listSessions(parsed.fields),
        parsed.fields,
        parsed.format === "json",
      );
    } else if (parsed.kind === "serve") {
      result = await context.service.serve(parsed.entry ?? "", parsed.root);
      result.help = [
        `Run \`htmlview stop <session>${parsed.format === "json" ? " --json" : ""}\` to stop this session`,
      ];
    } else {
      if (parsed.all) result = await context.service.stopAll();
      else if (parsed.session !== undefined)
        result = await context.service.stopSession(parsed.session);
      else throw new Error("htmlview could not resolve the stop target");
    }
    context.stdout(serialize(result, parsed.format));
    return 0;
  } catch (error) {
    let failure: JsonObject;
    if (isOperationalError(error)) {
      const publicError = toPublicError(error);
      failure = errorResult(
        publicError.code,
        publicError.message,
        {},
        runtimeHelp(error, parsed),
      );
    } else {
      failure = errorResult(
        "runtime.internal",
        "htmlview could not complete the request",
      );
    }
    context.stdout(serialize(failure, parsed.format));
    return 1;
  }
}
