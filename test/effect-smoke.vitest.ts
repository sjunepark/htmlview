import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

class SmokeError extends Schema.TaggedErrorClass<SmokeError>()("SmokeError", {
  message: Schema.String,
}) {}

const SmokeValue = Schema.Struct({ value: Schema.Number });

it.effect("supports schemas, tagged errors, scopes, and the test clock", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(SmokeValue)({ value: 1 });
    const finalizers: string[] = [];

    yield* Effect.scoped(
      Effect.acquireRelease(Effect.succeed(decoded), () =>
        Effect.sync(() => finalizers.push("released")),
      ),
    );
    expect(finalizers).toEqual(["released"]);

    const failure = yield* Effect.flip(
      new SmokeError({ message: "expected smoke failure" }),
    );
    expect(failure._tag).toBe("SmokeError");

    const sleeper = yield* Effect.sleep("1 second").pipe(
      Effect.as("awake"),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(sleeper)).toBe("awake");
  }),
);
