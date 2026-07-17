import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { logDiagnostic } from "../src/diagnostics.js";
import {
  maximumSupervisorLogBytes,
  maximumSupervisorLogFiles,
  supervisorDiagnosticLayer,
} from "../src/supervisor/logging.js";
import { statePaths } from "../src/supervisor/state.js";

function withTemporaryState<A, E, R>(
  use: (parent: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-log-"))),
    use,
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
  );
}

it.effect(
  "writes only allowlisted diagnostics to private supervisor storage",
  () =>
    withTemporaryState((parent) => {
      const paths = statePaths({
        HTMLVIEW_STATE_DIR: path.join(parent, "state"),
      });
      return Effect.gen(function* () {
        yield* Effect.all([
          logDiagnostic("Debug", { operation: "supervisor.run" }),
          logDiagnostic("Info", {
            operation: "supervisor.start",
            itemCount: 1,
          }),
        ]).pipe(Effect.provide(supervisorDiagnosticLayer(paths)));

        const directoryMode =
          (yield* Effect.promise(() => stat(paths.diagnosticLogDirectory)))
            .mode & 0o777;
        const fileMode =
          (yield* Effect.promise(() => stat(paths.diagnosticLogFile))).mode &
          0o777;
        expect(directoryMode).toBe(0o700);
        expect(fileMode).toBe(0o600);

        const lines = (yield* Effect.promise(() =>
          readFile(paths.diagnosticLogFile, "utf8"),
        ))
          .trim()
          .split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
          level: "info",
          operation: "supervisor.start",
          item_count: 1,
        });
      });
    }),
);

it.effect("rotates before crossing the exact per-file bound", () =>
  withTemporaryState((parent) => {
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        mkdir(paths.diagnosticLogDirectory, {
          recursive: true,
          mode: 0o700,
        }),
      );
      for (let iteration = 0; iteration < 4; iteration += 1) {
        yield* Effect.promise(() =>
          writeFile(
            paths.diagnosticLogFile,
            "x".repeat(maximumSupervisorLogBytes - 1),
            { mode: 0o600 },
          ),
        );
        yield* logDiagnostic("Info", {
          operation: "supervisor.start",
        }).pipe(Effect.provide(supervisorDiagnosticLayer(paths)));
      }

      const names = (yield* Effect.promise(() =>
        readdir(paths.diagnosticLogDirectory),
      )).sort();
      expect(names).toEqual([
        "supervisor.jsonl",
        "supervisor.jsonl.1",
        "supervisor.jsonl.2",
      ]);
      expect(names).toHaveLength(maximumSupervisorLogFiles);
      for (const name of names)
        expect(
          (yield* Effect.promise(() =>
            stat(path.join(paths.diagnosticLogDirectory, name)),
          )).size,
        ).toBeLessThanOrEqual(maximumSupervisorLogBytes);
    });
  }),
);

it.effect("prunes excess and oversized recognized generations on startup", () =>
  withTemporaryState((parent) => {
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        mkdir(paths.diagnosticLogDirectory, {
          recursive: true,
          mode: 0o700,
        }),
      );
      yield* Effect.promise(() =>
        writeFile(
          `${paths.diagnosticLogFile}.1`,
          "x".repeat(maximumSupervisorLogBytes + 1),
          { mode: 0o600 },
        ),
      );
      yield* Effect.promise(() =>
        writeFile(`${paths.diagnosticLogFile}.3`, "old", { mode: 0o600 }),
      );
      yield* Effect.promise(() =>
        writeFile(`${paths.diagnosticLogFile}.2`, "retained", { mode: 0o644 }),
      );

      yield* logDiagnostic("Info", {
        operation: "supervisor.start",
      }).pipe(Effect.provide(supervisorDiagnosticLayer(paths)));

      const names = yield* Effect.promise(() =>
        readdir(paths.diagnosticLogDirectory),
      );
      expect(names.sort()).toEqual(["supervisor.jsonl", "supervisor.jsonl.2"]);
      expect(
        (yield* Effect.promise(() => stat(`${paths.diagnosticLogFile}.2`)))
          .mode & 0o777,
      ).toBe(0o600);
    });
  }),
);

it.effect("rejects a symlinked supervisor log directory", () =>
  withTemporaryState((parent) => {
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const target = path.join(parent, "outside");
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        mkdir(paths.directory, { recursive: true, mode: 0o700 }),
      );
      yield* Effect.promise(() => mkdir(target, { mode: 0o700 }));
      yield* Effect.promise(() =>
        symlink(target, paths.diagnosticLogDirectory),
      );
      const exit = yield* Effect.exit(
        logDiagnostic("Info", { operation: "supervisor.start" }).pipe(
          Effect.provide(supervisorDiagnosticLayer(paths)),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  }),
);

it.effect("rejects symlinked current and retained supervisor log files", () =>
  withTemporaryState((parent) => {
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        mkdir(paths.diagnosticLogDirectory, {
          recursive: true,
          mode: 0o700,
        }),
      );
      const outside = path.join(parent, "outside.log");
      yield* Effect.promise(() => writeFile(outside, "outside"));

      for (const file of [
        paths.diagnosticLogFile,
        `${paths.diagnosticLogFile}.1`,
      ]) {
        yield* Effect.promise(() => symlink(outside, file));
        const exit = yield* Effect.exit(
          logDiagnostic("Info", { operation: "supervisor.start" }).pipe(
            Effect.provide(supervisorDiagnosticLayer(paths)),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        yield* Effect.promise(() => rm(file));
      }
      expect(yield* Effect.promise(() => readFile(outside, "utf8"))).toBe(
        "outside",
      );
    });
  }),
);
