import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { Effect, Logger } from "effect";
import { logDiagnostic, makeDiagnosticLogger } from "../src/diagnostics.js";

async function capture(effect: Effect.Effect<void>): Promise<string[]> {
  const lines: string[] = [];
  await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Logger.layer([makeDiagnosticLogger((line) => lines.push(line))]),
      ),
    ),
  );
  return lines;
}

async function sourceFiles(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(file)
        : Promise.resolve(entry.name.endsWith(".ts") ? [file] : []);
    }),
  );
  return nested.flat();
}

describe("diagnostic event seam", () => {
  it("serializes only the fixed allowlisted event shape", async () => {
    const [line] = await capture(
      logDiagnostic("Error", {
        operation: "cli.runtime",
        code: "runtime.internal",
        internalId: "12345678-1234-1234-1234-123456789abc",
        durationMilliseconds: 42,
        itemCount: 3,
        failureCount: 1,
      }),
    );
    const event = JSON.parse(line ?? "") as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), [
      "code",
      "duration_ms",
      "failure_count",
      "internal_id",
      "item_count",
      "level",
      "operation",
      "timestamp",
    ]);
    assert.equal(event.level, "error");
    assert.equal(event.operation, "cli.runtime");
  });

  it("drops arbitrary messages, causes, extra fields, and unbounded values", async () => {
    const canary = "<secret-path cookie=credential>";
    const lines = await capture(
      Effect.all([
        Effect.logError(canary),
        Effect.logError(new Error(canary)),
        Effect.logError({
          operation: "cli.runtime",
          code: "runtime.internal",
          internalId: "12345678-1234-1234-1234-123456789abc",
          secret: canary,
        }),
        Effect.logError({
          operation: "cli.runtime",
          durationMilliseconds: 86_400_001,
        }),
        Effect.logError({
          operation: "cli.runtime",
          itemCount: 1_000_001,
        }),
        Effect.logError({
          operation: "cli.runtime",
          internalId: canary,
        }),
        Effect.logError(
          { operation: "cli.runtime" },
          { operation: "cli.runtime" },
        ),
      ]).pipe(Effect.asVoid),
    );
    assert.deepEqual(lines, []);
  });

  it("does not let a failed sink replace the logged operation", async () => {
    await Effect.runPromise(
      logDiagnostic("Error", {
        operation: "cli.runtime",
        code: "runtime.internal",
      }).pipe(
        Effect.provide(
          Logger.layer([
            makeDiagnosticLogger(() => {
              throw new Error("sink failed");
            }),
          ]),
        ),
      ),
    );
  });
});

it("keeps direct Effect logging behind the diagnostic seam", async () => {
  const source = path.resolve("src");
  const violations: Array<string> = [];
  for (const file of await sourceFiles(source)) {
    if (file === path.join(source, "diagnostics.ts")) continue;
    const body = await readFile(file, "utf8");
    if (
      /\bEffect\.log(?:WithLevel|Trace|Debug|Info|Warning|Error|Fatal)?\s*\(/.test(
        body,
      )
    )
      violations.push(path.relative(source, file));
  }
  assert.deepEqual(violations, []);
});
