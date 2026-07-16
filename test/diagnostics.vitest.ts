import assert from "node:assert/strict";
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
});
