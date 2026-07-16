import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { format as formatConsole } from "node:util";
import { Console, Effect, Option } from "effect";
import {
  Argument,
  CliError,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli";
import type { JsonObject, OutputFormat } from "./contracts.js";
import { errorResult } from "./contracts.js";
import {
  foregroundDiagnosticLayer,
  logDiagnostic,
  type DiagnosticOperation,
} from "./diagnostics.js";
import { toPublicError, type OperationalError } from "./errors.js";
import { serialize } from "./output.js";
import { CommandService } from "./service.js";
import type {
  OptionalSessionField,
  ReviewSummary,
  SessionSummary,
} from "./supervisor/protocol.js";
import { htmlviewVersion } from "./version.js";

export interface AppContext {
  readonly executablePath: string;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

type DomainInvocation =
  | {
      readonly kind: "home";
      readonly format: OutputFormat;
      readonly fields: readonly OptionalSessionField[];
    }
  | {
      readonly kind: "serve";
      readonly format: OutputFormat;
      readonly root?: string;
    }
  | {
      readonly kind: "stop";
      readonly format: OutputFormat;
      readonly session?: string;
      readonly all: boolean;
    }
  | {
      readonly kind: "review";
      readonly format: OutputFormat;
      readonly session: string;
    }
  | {
      readonly kind: "feedback";
      readonly format: OutputFormat;
      readonly review: string;
      readonly wait: boolean;
      readonly after?: number;
    }
  | {
      readonly kind: "delete-review";
      readonly format: OutputFormat;
      readonly review: string;
      readonly discardFeedback: boolean;
    };

const JsonOutput = GlobalFlag.setting("json")({
  flag: Flag.boolean("json").pipe(
    Flag.withDescription("Encode domain results as JSON instead of TOON"),
  ),
});

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
  reviews: readonly ReviewSummary[],
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
    review_count: reviews.length,
    reviews: reviews.map((review) => ({ ...review })),
    help:
      selected.length === 0 && reviews.length === 0
        ? homeHelp(json)
        : [
            ...(reviews.some((review) => review.unacknowledged > 0)
              ? [
                  `Run \`htmlview feedback <review>${json ? " --json" : ""}\` to read pending feedback`,
                ]
              : []),
            ...(selected.length > 0
              ? [
                  `Run \`htmlview review <session>${json ? " --json" : ""}\` for human annotation`,
                  `Run \`htmlview stop <session>${json ? " --json" : ""}\` to stop a session`,
                ]
              : []),
            ...(selected.length > 1 && fields.length === 0
              ? [
                  `Run \`htmlview --fields entry,root${json ? " --json" : ""}\` to show session paths`,
                ]
              : []),
          ],
  };
}

function runtimeHelp(
  error: OperationalError,
  invocation: DomainInvocation,
): string[] {
  const jsonSuffix = invocation.format === "json" ? " --json" : "";
  switch (error._tag) {
    case "PathError":
      return [
        `Run \`htmlview serve --help${jsonSuffix}\` to review entry and root requirements`,
      ];
    case "RuntimeStateError": {
      const command =
        invocation.kind === "serve"
          ? `htmlview serve <entry.html>${invocation.root === undefined ? "" : " --root <directory>"}${jsonSuffix}`
          : invocation.kind === "stop"
            ? `htmlview stop${invocation.all ? " --all" : " <session>"}${jsonSuffix}`
            : invocation.kind === "home"
              ? `htmlview${invocation.fields.length > 0 ? ` --fields ${invocation.fields.join(",")}` : ""}${jsonSuffix}`
              : invocation.kind === "review"
                ? `htmlview review <session>${jsonSuffix}`
                : invocation.kind === "feedback"
                  ? `htmlview feedback <review>${jsonSuffix}`
                  : `htmlview review delete <review>${jsonSuffix}`;
      return [`Run \`${command}\` after correcting runtime-state permissions`];
    }
    case "ContentListenerError":
      if (invocation.kind !== "serve" && invocation.kind !== "review")
        return [];
      return [
        invocation.kind === "review"
          ? `Run \`htmlview review <session>${jsonSuffix}\` to retry`
          : `Run \`htmlview serve <entry.html>${invocation.root === undefined ? "" : " --root <directory>"}${jsonSuffix}\` to retry`,
      ];
    case "ReviewError":
      if (error.code === "review.pending_feedback")
        return [
          `Run \`htmlview feedback <review>${jsonSuffix}\` or retry deletion with --discard-feedback`,
        ];
      return [];
    case "FeedbackError":
      return error.code === "feedback.cursor_ahead"
        ? [`Run \`htmlview feedback <review>${jsonSuffix}\` without --after`]
        : [];
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
      if (
        error.code === "supervisor.start_failed" &&
        invocation.kind === "serve"
      )
        return [
          `Run \`htmlview serve <entry.html>${invocation.root === undefined ? "" : " --root <directory>"}${jsonSuffix}\` to retry`,
        ];
      return [];
  }
}

function parseSessionFields(value: string): readonly OptionalSessionField[] {
  const fields = value.split(",");
  if (
    fields.length === 0 ||
    fields.some((field) => field !== "entry" && field !== "root")
  )
    throw new Error("entry, root, or entry,root");
  return [...new Set(fields)] as OptionalSessionField[];
}

function appConsole(context: AppContext): Console.Console {
  const native = globalThis.console;
  return {
    assert: native.assert.bind(native),
    clear: native.clear.bind(native),
    count: native.count.bind(native),
    countReset: native.countReset.bind(native),
    debug: native.debug.bind(native),
    dir: native.dir.bind(native),
    dirxml: native.dirxml.bind(native),
    error: (...values) => context.stderr(formatConsole(...values)),
    group: native.group.bind(native),
    groupCollapsed: native.groupCollapsed.bind(native),
    groupEnd: native.groupEnd.bind(native),
    info: native.info.bind(native),
    log: (...values) => context.stdout(formatConsole(...values)),
    table: native.table.bind(native),
    time: native.time.bind(native),
    timeEnd: native.timeEnd.bind(native),
    timeLog: native.timeLog.bind(native),
    trace: native.trace.bind(native),
    warn: native.warn.bind(native),
  };
}

function domainHandler(
  context: AppContext,
  operation: DiagnosticOperation,
  invocation: (format: OutputFormat) => DomainInvocation,
  execute: (
    format: OutputFormat,
  ) => Effect.Effect<JsonObject, OperationalError, CommandService>,
  setFailure: () => void,
): Effect.Effect<
  void,
  never,
  CommandService | GlobalFlag.Setting.Identifier<"json">
> {
  return Effect.flatMap(JsonOutput, (json) => {
    const format: OutputFormat = json ? "json" : "toon";
    const selectedInvocation = invocation(format);
    return Effect.gen(function* () {
      yield* logDiagnostic("Debug", { operation });
      const result = yield* execute(format);
      context.stdout(serialize(result, format));
    }).pipe(
      Effect.catch((error: OperationalError) => {
        const publicError = toPublicError(error);
        return Effect.gen(function* () {
          yield* logDiagnostic("Debug", {
            operation,
            code: publicError.code,
          });
          setFailure();
          context.stdout(
            serialize(
              errorResult(
                publicError.code,
                publicError.message,
                publicError.details ?? {},
                runtimeHelp(error, selectedInvocation),
              ),
              format,
            ),
          );
        });
      }),
      Effect.catchDefect(() =>
        Effect.gen(function* () {
          setFailure();
          yield* logDiagnostic("Error", {
            operation,
            code: "runtime.internal",
            internalId: randomUUID(),
          });
          context.stdout(
            serialize(
              errorResult(
                "runtime.internal",
                "htmlview could not complete the request",
              ),
              format,
            ),
          );
        }),
      ),
    );
  });
}

function stopUsageFailure(message: string): CliError.ShowHelp {
  return new CliError.ShowHelp({
    commandPath: ["htmlview", "stop"],
    errors: [
      new CliError.InvalidValue({
        option: "all",
        value: message,
        expected: "choose exactly one of <session> or --all",
        kind: "flag",
      }),
    ],
  });
}

function makeHtmlviewCommand(context: AppContext, setFailure: () => void) {
  const fields = Flag.string("fields").pipe(
    Flag.withMetavar("<entry,root>"),
    Flag.withDescription("Add entry and/or root to home session rows"),
    Flag.mapTryCatch(parseSessionFields, () => "entry, root, or entry,root"),
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? []),
  );

  const rootCommand = Command.make("htmlview", { fields }, ({ fields }) => {
    return domainHandler(
      context,
      "cli.home",
      (format) => ({ kind: "home", format, fields }),
      (format) =>
        Effect.flatMap(CommandService, (service) =>
          Effect.map(service.listState(fields), (state) =>
            homeResult(
              context.executablePath,
              state.sessions,
              state.reviews,
              fields,
              format === "json",
            ),
          ),
        ),
      setFailure,
    );
  }).pipe(
    Command.withDescription("Serve local HTML through confined loopback HTTP"),
    Command.withExamples([
      { command: "htmlview", description: "Show active htmlview state" },
      {
        command: "htmlview --fields entry,root",
        description: "Include granted paths in session rows",
      },
    ]),
  );

  const serveRoot = Flag.string("root").pipe(
    Flag.withMetavar("<directory>"),
    Flag.withDescription("Explicit serving root (defaults to entry parent)"),
    Flag.atMost(1),
    Flag.map((values) => values[0]),
  );
  const serveCommand = Command.make(
    "serve",
    {
      root: serveRoot,
      entry: Argument.string("entry.html").pipe(
        Argument.withDescription("Existing .html or .htm entry file"),
      ),
    },
    ({ entry, root }) =>
      domainHandler(
        context,
        "cli.serve",
        (format) => ({
          kind: "serve",
          format,
          ...(root === undefined ? {} : { root }),
        }),
        (format) =>
          Effect.flatMap(CommandService, (service) =>
            Effect.map(service.serve(entry, root), (result) => ({
              ...result,
              help: [
                `Run \`htmlview stop <session>${format === "json" ? " --json" : ""}\` to stop this session`,
              ],
            })),
          ),
        setFailure,
      ),
  ).pipe(
    Command.withDescription("Serve one explicitly granted local HTML tree"),
    Command.withExamples([
      { command: "htmlview serve ./report.html" },
      { command: "htmlview serve --root . ./public/report.html" },
    ]),
  );

  const deleteReviewCommand = Command.make(
    "delete",
    {
      discardFeedback: Flag.boolean("discard-feedback").pipe(
        Flag.withDescription(
          "Explicitly discard queued and unacknowledged feedback",
        ),
        Flag.atMost(1),
        Flag.map((values) => values[0] ?? false),
      ),
      review: Argument.string("review").pipe(
        Argument.withDescription("Retained review identifier"),
      ),
    },
    ({ discardFeedback, review }) =>
      domainHandler(
        context,
        "cli.review.delete",
        (format) => ({
          kind: "delete-review",
          format,
          review,
          discardFeedback,
        }),
        () =>
          Effect.flatMap(CommandService, (service) =>
            service.deleteReview(review, discardFeedback),
          ),
        setFailure,
      ),
  ).pipe(
    Command.withDescription("Delete retained review state"),
    Command.withExamples([
      { command: "htmlview review delete <review>" },
      { command: "htmlview review delete --discard-feedback <review>" },
    ]),
  );

  const reviewCommand = Command.make(
    "review",
    {
      session: Argument.string("session").pipe(
        Argument.withDescription("Ready raw-session identifier"),
      ),
    },
    ({ session }) =>
      domainHandler(
        context,
        "cli.review",
        (format) => ({ kind: "review", format, session }),
        (format) =>
          Effect.flatMap(CommandService, (service) =>
            Effect.map(service.review(session), (result) => ({
              ...result,
              help: [
                `Run \`htmlview feedback --wait <review>${format === "json" ? " --json" : ""}\``,
              ],
            })),
          ),
        setFailure,
      ),
  ).pipe(
    Command.withDescription("Create or resume a human annotation review"),
    Command.withExamples([{ command: "htmlview review <session>" }]),
    Command.withSubcommands([deleteReviewCommand]),
  );

  const wait = Flag.boolean("wait").pipe(
    Flag.withDescription("Wait until feedback or terminal review state"),
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? false),
  );
  const after = Flag.integer("after").pipe(
    Flag.withDescription("Acknowledge a previously delivered feedback cursor"),
    Flag.atMost(1),
    Flag.map((values) => values[0]),
    Flag.mapTryCatch(
      (value) => {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
          throw new Error("a non-negative safe integer");
        return value;
      },
      () => "a non-negative safe integer",
    ),
  );
  const feedbackCommand = Command.make(
    "feedback",
    {
      wait,
      after,
      review: Argument.string("review").pipe(
        Argument.withDescription("Retained review identifier"),
      ),
    },
    ({ wait, after, review }) =>
      domainHandler(
        context,
        "cli.feedback",
        (format) => ({
          kind: "feedback",
          format,
          review,
          wait,
          ...(after === undefined ? {} : { after }),
        }),
        (format) =>
          Effect.flatMap(CommandService, (service) =>
            Effect.map(
              service.feedback(review, {
                wait,
                ...(after === undefined ? {} : { after }),
              }),
              (result) => ({
                ...result,
                help: [
                  `Run \`htmlview feedback --after <cursor> --wait <review>${format === "json" ? " --json" : ""}\``,
                ],
              }),
            ),
          ),
        setFailure,
      ),
  ).pipe(
    Command.withDescription("Read or wait for durable review feedback"),
    Command.withExamples([
      { command: "htmlview feedback <review>" },
      { command: "htmlview feedback --wait <review>" },
    ]),
  );

  const all = Flag.boolean("all").pipe(
    Flag.withDescription("Stop every active raw session"),
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? false),
  );
  const stopCommand = Command.make(
    "stop",
    {
      all,
      session: Argument.string("session").pipe(
        Argument.withDescription("Session identifier unless --all is used"),
        Argument.optional,
      ),
    },
    ({ all, session }) => {
      const selected = Option.getOrUndefined(session);
      if ((all && selected !== undefined) || (!all && selected === undefined))
        return Effect.fail(
          stopUsageFailure(
            all ? "--all with <session>" : "neither target was provided",
          ),
        );
      return domainHandler(
        context,
        "cli.stop",
        (format) => ({
          kind: "stop",
          format,
          all,
          ...(selected === undefined ? {} : { session: selected }),
        }),
        () =>
          Effect.flatMap(CommandService, (service) =>
            all ? service.stopAll() : service.stopSession(selected ?? ""),
          ),
        setFailure,
      );
    },
  ).pipe(
    Command.withDescription("Stop one raw session or all raw sessions"),
    Command.withExamples([
      { command: "htmlview stop <session>" },
      { command: "htmlview stop --all" },
    ]),
  );

  return rootCommand.pipe(
    Command.withSubcommands([
      serveCommand,
      reviewCommand,
      feedbackCommand,
      stopCommand,
    ]),
    Command.withGlobalFlags([JsonOutput]),
  );
}

export function runApp(
  argv: readonly string[],
  context: AppContext,
): Effect.Effect<number, never, CommandService | Command.Environment> {
  let failed = false;
  const command = makeHtmlviewCommand(context, () => {
    failed = true;
  });
  const run = Command.runWith(command, { version: htmlviewVersion })(argv);
  return run.pipe(
    Effect.asVoid,
    Effect.match({
      onFailure: () => 1,
      onSuccess: () => (failed ? 1 : 0),
    }),
    Effect.catchDefect(() =>
      Effect.gen(function* () {
        yield* logDiagnostic("Error", {
          operation: "cli.runtime",
          code: "runtime.internal",
          internalId: randomUUID(),
        });
        context.stdout(
          serialize(
            errorResult(
              "runtime.internal",
              "htmlview could not complete the request",
            ),
            "toon",
          ),
        );
        return 1;
      }),
    ),
    Effect.provideService(Console.Console, appConsole(context)),
    Effect.provide(foregroundDiagnosticLayer(context.stderr)),
  );
}
