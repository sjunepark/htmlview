import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Exit, Scope } from "effect";
import { describe, it } from "vitest";
import { resolveServingGrant } from "../src/serving/grant.js";
import {
  startReviewEntryObserver,
  type ReviewEntryObservation,
} from "../src/serving/review-entry-observer.js";
import type { ServedFileSnapshot } from "../src/serving/http.js";

function revision(source: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function servedFile(target: string): Promise<ServedFileSnapshot> {
  const [body, metadata] = await Promise.all([
    readFile(target),
    stat(target, { bigint: true }),
  ]);
  return {
    target,
    metadata: {
      size: metadata.size,
      modifiedNanoseconds: metadata.mtimeNs,
      inode: metadata.ino,
    },
    revision: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
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

  it("polls bounded served assets and ignores unrelated or byte-identical writes", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "htmlview-asset-observer-"),
    );
    const root = path.join(parent, "root");
    const entry = path.join(root, "index.html");
    const assets = path.join(root, "assets");
    const stylesheet = path.join(assets, "site.css");
    const unrelated = path.join(root, "unrelated.txt");
    const initial = "<!doctype html><link rel=stylesheet href=assets/site.css>";
    const green = "body { color: green; }";
    const blue = "body { color: blue; }";
    await mkdir(assets, { recursive: true });
    await writeFile(entry, initial);
    await writeFile(stylesheet, green);
    await writeFile(unrelated, "initial");
    const grant = await Effect.runPromise(resolveServingGrant(entry, { root }));
    const observations: ReviewEntryObservation[] = [];
    const scope = await Effect.runPromise(Scope.make());
    try {
      const observer = await Effect.runPromise(
        Scope.provide(scope)(
          startReviewEntryObserver(
            grant,
            (observation) => observations.push(observation),
            {
              quietMilliseconds: 10,
              pollMilliseconds: 20,
              forcedPollInterval: 1,
              watchFactory: () => {
                throw new Error("watch unavailable");
              },
            },
          ),
        ),
      );
      const initialServedAsset = await servedFile(
        path.join(grant.root, "assets", "site.css"),
      );
      observer.recordServedFile(initialServedAsset);
      const baselineCount = observations.length;

      const firstDuplicate =
        observer.beginServedFileObservation(initialServedAsset);
      const secondDuplicate =
        observer.beginServedFileObservation(initialServedAsset);
      assert.notEqual(firstDuplicate, undefined);
      assert.notEqual(secondDuplicate, undefined);
      firstDuplicate?.cancel();
      secondDuplicate?.complete(initialServedAsset.revision);
      assert.equal(observations.length, baselineCount);

      const reservations = Array.from({ length: 127 }, (_, index) =>
        observer.beginServedFileObservation({
          target: path.join(grant.root, "assets", `reserved-${index}.css`),
          metadata: initialServedAsset.metadata,
        }),
      );
      assert.equal(
        reservations.every((reservation) => reservation !== undefined),
        true,
      );
      assert.equal(
        observer.beginServedFileObservation({
          target: path.join(grant.root, "assets", "beyond-cap.css"),
          metadata: initialServedAsset.metadata,
        }),
        undefined,
      );
      const saturatedTarget = path.join(grant.root, "assets", "reserved-0.css");
      const saturatedDuplicate = observer.beginServedFileObservation({
        target: saturatedTarget,
        metadata: initialServedAsset.metadata,
      });
      assert.notEqual(saturatedDuplicate, undefined);
      reservations[0]?.cancel();
      await writeFile(saturatedTarget, green);
      saturatedDuplicate?.complete(revision(green));
      assert.equal(observations.length, baselineCount);
      for (const reservation of reservations) reservation?.cancel();
      const releasedReservation = observer.beginServedFileObservation({
        target: path.join(grant.root, "assets", "released-slot.css"),
        metadata: initialServedAsset.metadata,
      });
      assert.notEqual(releasedReservation, undefined);
      releasedReservation?.cancel();

      await writeFile(unrelated, "changed but never served");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observations.length, baselineCount);

      await writeFile(stylesheet, green);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observations.length, baselineCount);

      await writeFile(stylesheet, blue);
      await waitFor(() => observations.length > baselineCount);
      assert.equal(observations.length, baselineCount + 1);
      const changed = observations.at(-1);
      assert.equal(changed?.availability, "available");
      if (changed?.availability === "available") {
        assert.equal(changed.revision, revision(initial));
        assert.match(changed.asset_revision ?? "", /^sha256:[0-9a-f]{64}$/);
      }

      const changedCount = observations.length;
      await writeFile(stylesheet, blue);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observations.length, changedCount);

      observer.recordServedFile(initialServedAsset);
      assert.equal(observations.length, changedCount + 1);
      const reServed = observations.at(-1);
      assert.equal(reServed?.availability, "available");
      if (reServed?.availability === "available") {
        assert.equal(reServed.revision, revision(initial));
        assert.notEqual(reServed.asset_revision, changed?.asset_revision);
      }
      observer.recordServedFile(initialServedAsset);
      assert.equal(observations.length, changedCount + 1);

      await Effect.runPromise(Scope.close(scope, Exit.void));
      await writeFile(stylesheet, blue);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observations.length, changedCount + 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(parent, { recursive: true, force: true });
    }
  });
});
