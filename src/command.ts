import type {
  JsonObject,
  OptionalSessionField,
  OutputFormat,
  UsageFailure,
} from "./contracts.js";
import { errorResult } from "./contracts.js";

export type ParsedCommand =
  | {
      readonly kind: "home";
      readonly format: OutputFormat;
      readonly fields: readonly OptionalSessionField[];
      readonly help: boolean;
    }
  | {
      readonly kind: "serve";
      readonly format: OutputFormat;
      readonly entry?: string;
      readonly root?: string;
      readonly help: boolean;
    }
  | {
      readonly kind: "stop";
      readonly format: OutputFormat;
      readonly session?: string;
      readonly all: boolean;
      readonly help: boolean;
    }
  | {
      readonly kind: "version";
      readonly format: OutputFormat;
      readonly help: false;
    };

const validCommands = ["serve", "stop"];
const homeFlags = ["--fields", "--json", "--help", "--version"];
const serveFlags = ["--root", "--json", "--help"];
const stopFlags = ["--all", "--json", "--help"];

function usageFailure(
  code: string,
  message: string,
  details: JsonObject,
  help: string,
): UsageFailure {
  return { exitCode: 2, result: errorResult(code, message, details, [help]) };
}

function unknownFlag(
  flag: string,
  command: string,
  validFlags: string[],
): UsageFailure {
  return usageFailure(
    "usage.unknown_flag",
    `Unknown flag ${flag} for \`${command}\``,
    { valid_flags: validFlags },
    `Run \`${command} --help\` for complete examples`,
  );
}

function missingValue(
  flag: string,
  command: string,
  usage: string,
): UsageFailure {
  return usageFailure(
    "usage.missing_flag_value",
    `Flag ${flag} requires a value for \`${command}\``,
    { usage },
    `Run \`${command} --help\` for complete examples`,
  );
}

function takeValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("-") ? value : undefined;
}

export function parseCommand(
  argv: readonly string[],
): ParsedCommand | UsageFailure {
  const args = [...argv];
  const format: OutputFormat = args.includes("--json") ? "json" : "toon";
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index] === "--json") args.splice(index, 1);
  }

  if (args.length === 1 && args[0] === "--version")
    return { kind: "version", format, help: false };
  if (args.includes("--version"))
    return usageFailure(
      "usage.conflicting_arguments",
      "Flag --version cannot be combined with other arguments",
      { usage: "htmlview --version [--json]" },
      "Run `htmlview --help` for command examples",
    );

  if (args.length === 0 || args[0]?.startsWith("-"))
    return parseHome(args, format);

  const command = args[0];
  if (command !== "serve" && command !== "stop") {
    return usageFailure(
      "usage.unknown_command",
      `Unknown command ${command}`,
      { valid_commands: validCommands },
      "Run `htmlview --help` for command examples",
    );
  }

  return command === "serve"
    ? parseServe(args.slice(1), format)
    : parseStop(args.slice(1), format);
}

function parseHome(
  args: string[],
  format: OutputFormat,
): ParsedCommand | UsageFailure {
  let help = false;
  let fields: OptionalSessionField[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--fields") {
      const value = takeValue(args, index);
      if (value === undefined)
        return missingValue(
          "--fields",
          "htmlview",
          "htmlview [--fields entry,root] [--json]",
        );
      const requested = value.split(",");
      const unknown = requested.find(
        (field) => field !== "entry" && field !== "root",
      );
      if (unknown !== undefined) {
        return usageFailure(
          "usage.unknown_field",
          `Unknown session field ${unknown}`,
          { valid_fields: ["entry", "root"] },
          "Run `htmlview --help` for complete examples",
        );
      }
      fields = [...new Set(requested)] as OptionalSessionField[];
      index += 1;
      continue;
    }
    return argument.startsWith("-")
      ? unknownFlag(argument, "htmlview", homeFlags)
      : usageFailure(
          "usage.unexpected_argument",
          `Unexpected argument ${argument} for \`htmlview\``,
          { usage: "htmlview [--fields entry,root] [--json]" },
          "Run `htmlview --help` for complete examples",
        );
  }
  return { kind: "home", format, fields, help };
}

function parseServe(
  args: string[],
  format: OutputFormat,
): ParsedCommand | UsageFailure {
  let entry: string | undefined;
  let root: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--help") {
      help = true;
    } else if (argument === "--root") {
      const value = takeValue(args, index);
      if (value === undefined)
        return missingValue(
          "--root",
          "htmlview serve",
          "htmlview serve <entry.html> [--root <directory>] [--json]",
        );
      if (root !== undefined) {
        return usageFailure(
          "usage.duplicate_flag",
          "Flag --root may be provided only once",
          { valid_flags: serveFlags },
          "Run `htmlview serve --help` for complete examples",
        );
      }
      root = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      return unknownFlag(argument, "htmlview serve", serveFlags);
    } else if (entry === undefined) {
      entry = argument;
    } else {
      return usageFailure(
        "usage.unexpected_argument",
        `Unexpected argument ${argument} for \`htmlview serve\``,
        { usage: "htmlview serve <entry.html> [--root <directory>] [--json]" },
        "Run `htmlview serve --help` for complete examples",
      );
    }
  }
  if (entry === undefined && !help) {
    return usageFailure(
      "usage.missing_argument",
      "Missing required argument <entry.html> for `htmlview serve`",
      { usage: "htmlview serve <entry.html> [--root <directory>] [--json]" },
      "Run `htmlview serve --help` for complete examples",
    );
  }
  return {
    kind: "serve",
    format,
    ...(entry === undefined ? {} : { entry }),
    ...(root === undefined ? {} : { root }),
    help,
  };
}

function parseStop(
  args: string[],
  format: OutputFormat,
): ParsedCommand | UsageFailure {
  let session: string | undefined;
  let all = false;
  let help = false;
  for (const argument of args) {
    if (argument === "--help") help = true;
    else if (argument === "--all") all = true;
    else if (argument.startsWith("-"))
      return unknownFlag(argument, "htmlview stop", stopFlags);
    else if (session === undefined) session = argument;
    else {
      return usageFailure(
        "usage.unexpected_argument",
        `Unexpected argument ${argument} for \`htmlview stop\``,
        {
          usage:
            "htmlview stop <session> [--json] | htmlview stop --all [--json]",
        },
        "Run `htmlview stop --help` for complete examples",
      );
    }
  }
  if (all && session !== undefined) {
    return usageFailure(
      "usage.conflicting_arguments",
      "Choose either <session> or --all for `htmlview stop`",
      {
        usage:
          "htmlview stop <session> [--json] | htmlview stop --all [--json]",
      },
      "Run `htmlview stop --help` for complete examples",
    );
  }
  if (!all && session === undefined && !help) {
    return usageFailure(
      "usage.missing_argument",
      "Missing <session> or --all for `htmlview stop`",
      {
        usage:
          "htmlview stop <session> [--json] | htmlview stop --all [--json]",
      },
      "Run `htmlview stop --help` for complete examples",
    );
  }
  return {
    kind: "stop",
    format,
    ...(session === undefined ? {} : { session }),
    all,
    help,
  };
}
