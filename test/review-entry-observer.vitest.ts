import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
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
      await writeFile(replacement, rapidFinal);
      await rename(replacement, entry);
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

  it("force-reads changed asset candidates before publishing", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "htmlview-asset-confirmation-"),
    );
    const root = path.join(parent, "root");
    const assets = path.join(root, "assets");
    const entry = path.join(root, "index.html");
    const stylesheet = path.join(assets, "site.css");
    const initial = "<!doctype html><link rel=stylesheet href=assets/site.css>";
    const green = "#x{color:lime}";
    const blue = "#x{color:blue}";
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await mkdir(assets, { recursive: true });
    await writeFile(entry, initial);
    await writeFile(stylesheet, green);
    await utimes(stylesheet, fixedTime, fixedTime);
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
              quietMilliseconds: 100,
              pollMilliseconds: 200,
              forcedPollInterval: 1,
              watchFactory: () => {
                throw new Error("watch unavailable");
              },
            },
          ),
        ),
      );
      observer.recordServedFile(
        await servedFile(path.join(grant.root, "assets", "site.css")),
      );
      const baselineCount = observations.length;

      await writeFile(stylesheet, blue);
      await utimes(stylesheet, fixedTime, fixedTime);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(stylesheet, green);
      await utimes(stylesheet, fixedTime, fixedTime);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(observations.length, baselineCount);

      await writeFile(stylesheet, blue);
      await utimes(stylesheet, fixedTime, fixedTime);
      await waitFor(() => observations.length === baselineCount + 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("preserves every changed target across candidate transitions", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "htmlview-asset-candidate-union-"),
    );
    const root = path.join(parent, "root");
    const assets = path.join(root, "assets");
    const entry = path.join(root, "index.html");
    const primary = path.join(assets, "primary.css");
    const secondary = path.join(assets, "secondary.css");
    const initial =
      "<!doctype html><link rel=stylesheet href=assets/primary.css><link rel=stylesheet href=assets/secondary.css>";
    const green = "#x{color:lime}";
    const blue = "#x{color:blue}";
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    const watchListeners = new Map<
      string,
      (event: "rename" | "change", filename: string | Buffer | null) => void
    >();
    await mkdir(assets, { recursive: true });
    await writeFile(entry, initial);
    await writeFile(primary, green);
    await writeFile(secondary, green);
    await utimes(primary, fixedTime, fixedTime);
    await utimes(secondary, fixedTime, fixedTime);
    const grant = await Effect.runPromise(resolveServingGrant(entry, { root }));
    const canonicalAssets = path.join(grant.root, "assets");
    const canonicalPrimary = path.join(canonicalAssets, "primary.css");
    const canonicalSecondary = path.join(canonicalAssets, "secondary.css");
    const observations: ReviewEntryObservation[] = [];
    const scope = await Effect.runPromise(Scope.make());
    try {
      const observer = await Effect.runPromise(
        Scope.provide(scope)(
          startReviewEntryObserver(
            grant,
            (observation) => observations.push(observation),
            {
              quietMilliseconds: 500,
              pollMilliseconds: 1_000,
              forcedPollInterval: 1,
              watchFactory: (target, _options, listener) => {
                watchListeners.set(target, listener);
                return {
                  on() {
                    return this;
                  },
                  close() {},
                };
              },
            },
          ),
        ),
      );
      observer.recordServedFile(await servedFile(canonicalPrimary));
      observer.recordServedFile(await servedFile(canonicalSecondary));
      const baselineCount = observations.length;

      await writeFile(primary, blue);
      await utimes(primary, fixedTime, fixedTime);
      await new Promise((resolve) => setTimeout(resolve, 1_250));

      await writeFile(secondary, blue);
      watchListeners.get(canonicalAssets)?.("change", "secondary.css");
      await new Promise((resolve) => setTimeout(resolve, 650));

      await writeFile(primary, green);
      await utimes(primary, fixedTime, fixedTime);
      await waitFor(() => observations.length === baselineCount + 1, 3_000);

      observer.recordServedFile(await servedFile(canonicalPrimary));
      assert.equal(observations.length, baselineCount + 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(parent, { recursive: true, force: true });
    }
  }, 8_000);

  it("resets tracked assets when a new entry revision is confirmed", async () => {
    const parent = await mkdtemp(
      path.join(tmpdir(), "htmlview-asset-generation-"),
    );
    const root = path.join(parent, "root");
    const assets = path.join(root, "assets");
    const entry = path.join(root, "index.html");
    const stylesheet = path.join(assets, "site.css");
    const initial = "<!doctype html><link rel=stylesheet href=assets/site.css>";
    const changedEntry = "<!doctype html><p>replacement without assets</p>";
    const green = "body { color: green; }";
    const blue = "body { color: blue; }";
    const watchListeners = new Map<
      string,
      (event: "rename" | "change", filename: string | Buffer | null) => void
    >();
    await mkdir(assets, { recursive: true });
    await writeFile(entry, initial);
    await writeFile(stylesheet, green);
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
              pollMilliseconds: 10_000,
              watchFactory: (target, _options, listener) => {
                watchListeners.set(target, listener);
                return {
                  on() {
                    return this;
                  },
                  close() {},
                };
              },
            },
          ),
        ),
      );
      const canonicalAssets = path.join(grant.root, "assets");
      const initialAsset = await servedFile(
        path.join(canonicalAssets, "site.css"),
      );
      observer.recordServedFile(initialAsset);
      const staleObservation =
        observer.beginServedFileObservation(initialAsset);
      assert.notEqual(staleObservation, undefined);
      for (let index = 1; index < 128; index += 1)
        observer.recordServedFile({
          ...initialAsset,
          target: path.join(canonicalAssets, `old-${index}.css`),
        });
      assert.equal(
        observer.beginServedFileObservation({
          ...initialAsset,
          target: path.join(canonicalAssets, "over-cap.css"),
        }),
        undefined,
      );
      await writeFile(entry, changedEntry);
      watchListeners.get(grant.root)?.("change", "index.html");
      await waitFor(() => {
        const latest = observations.at(-1);
        return (
          latest?.availability === "available" &&
          latest.revision === revision(changedEntry)
        );
      });
      assert.deepEqual(observations.at(-1), {
        availability: "available",
        revision: revision(changedEntry),
      });

      staleObservation?.complete(initialAsset.revision);
      const newObservation = observer.beginServedFileObservation({
        ...initialAsset,
        target: path.join(canonicalAssets, "new.css"),
      });
      assert.notEqual(newObservation, undefined);
      newObservation?.cancel();

      const resetCount = observations.length;
      await writeFile(stylesheet, blue);
      watchListeners.get(canonicalAssets)?.("change", "site.css");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observations.length, resetCount);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(parent, { recursive: true, force: true });
    }
  });
});
