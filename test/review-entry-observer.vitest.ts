import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Exit, Scope } from "effect";
import { describe, it } from "vitest";
import { resolveServingGrant } from "../src/serving/grant.js";
import {
  startReviewEntryObserver,
  type ReviewEntryObservation,
} from "../src/serving/review-entry-observer.js";

function revision(source: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for entry observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("review entry observer", () => {
  it("coalesces confirmed entry changes and closes with its review scope", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "htmlview-entry-observer-"),
    );
    const root = path.join(parent, "root");
    const entry = path.join(root, "index.html");
    const moved = path.join(root, "moved.html");
    const replacement = path.join(root, "replacement.html");
    const initial = "<!doctype html><p>initial</p>";
    const rapidIntermediate = "<!doctype html><p>intermediate</p>";
    const rapidFinal = "<!doctype html><p>final</p>";
    const atomic = "<!doctype html><p>atomic</p>";
    await mkdir(root);
    await writeFile(entry, initial);
    const grant = await Effect.runPromise(resolveServingGrant(entry, { root }));
    const observations: ReviewEntryObservation[] = [];
    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Scope.provide(scope)(
          startReviewEntryObserver(
            grant,
            (observation) => observations.push(observation),
            {
              quietMilliseconds: 15,
              pollMilliseconds: 30,
              forcedPollInterval: 4,
            },
          ),
        ),
      );
      assert.deepEqual(observations, [
        { availability: "available", revision: revision(initial) },
      ]);

      await writeFile(entry, rapidIntermediate);
      await writeFile(entry, rapidFinal);
      await waitFor(() =>
        observations.some(
          (observation) =>
            observation.availability === "available" &&
            observation.revision === revision(rapidFinal),
        ),
      );
      assert.equal(
        observations.some(
          (observation) =>
            observation.availability === "available" &&
            observation.revision === revision(rapidIntermediate),
        ),
        false,
      );

      const unchangedCount = observations.length;
      await writeFile(entry, rapidFinal);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(observations.length, unchangedCount);

      await writeFile(replacement, atomic);
      await rename(replacement, entry);
      await waitFor(() =>
        observations.some(
          (observation) =>
            observation.availability === "available" &&
            observation.revision === revision(atomic),
        ),
      );

      await rename(entry, moved);
      await waitFor(() =>
        observations.some(
          (observation) => observation.availability === "unavailable",
        ),
      );
      await rename(moved, entry);
      await waitFor(() => {
        const latest = observations.at(-1);
        return (
          latest?.availability === "available" &&
          latest.revision === revision(atomic)
        );
      });

      await writeFile(entry, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
      await waitFor(() => {
        const latest = observations.at(-1);
        return (
          latest?.availability === "unsupported" &&
          latest.limitation === "entry_too_large"
        );
      });
      await writeFile(entry, atomic);
      await waitFor(() => {
        const latest = observations.at(-1);
        return (
          latest?.availability === "available" &&
          latest.revision === revision(atomic)
        );
      });

      await Effect.runPromise(Scope.close(scope, Exit.void));
      const closedCount = observations.length;
      await writeFile(entry, "<!doctype html><p>after close</p>");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(observations.length, closedCount);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(parent, { recursive: true, force: true });
    }
  });
});
