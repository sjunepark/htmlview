import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Effect, Result, Schema } from "effect";
import { RuntimeStateError } from "../errors.js";
import type { StatePaths } from "../supervisor/state.js";
import {
  type AnnotationState,
  AnnotationStateSchema,
  annotationStateIsConsistent,
  emptyAnnotationState,
} from "./model.js";

export const maximumAnnotationStoreBytes = 8 * 1024 * 1024;
export const maximumPersistedReviewBytes = 768 * 1024;
// Content mutations leave room for one maximum-path review plus cursor/status
// metadata, so mandatory delivery and shutdown commits cannot hit the hard cap.
const annotationStoreMutationHeadroomBytes = 128 * 1024;
const persistedReviewMutationHeadroomBytes = 1024;

const strict = { onExcessProperty: "error" } as const;
const decodeAnnotationState = Schema.decodeUnknownResult(
  AnnotationStateSchema,
  strict,
);

function annotationStateFitsBounds(
  state: AnnotationState,
  storeMaximumBytes: number,
  reviewMaximumBytes: number,
): boolean {
  try {
    if (
      state.reviews.some(
        (review) =>
          Buffer.byteLength(JSON.stringify(review)) > reviewMaximumBytes,
      )
    )
      return false;
    return Buffer.byteLength(JSON.stringify(state)) <= storeMaximumBytes;
  } catch {
    return false;
  }
}

export function annotationStateFitsStorageBounds(
  state: AnnotationState,
): boolean {
  return annotationStateFitsBounds(
    state,
    maximumAnnotationStoreBytes,
    maximumPersistedReviewBytes,
  );
}

export function annotationStateFitsMutationBounds(
  state: AnnotationState,
): boolean {
  return annotationStateFitsBounds(
    state,
    maximumAnnotationStoreBytes - annotationStoreMutationHeadroomBytes,
    maximumPersistedReviewBytes - persistedReviewMutationHeadroomBytes,
  );
}

function storeFailure(cause: unknown): RuntimeStateError {
  return new RuntimeStateError({
    code: "state.unavailable",
    message: "The private htmlview annotation state is unavailable",
    reason: "unavailable",
    cause,
  });
}

function ensureAnnotationDirectory(
  paths: StatePaths,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await mkdir(paths.annotationDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const metadata = await lstat(paths.annotationDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o700 ||
        (process.getuid !== undefined && metadata.uid !== process.getuid())
      )
        throw new Error("The annotation state directory is not private");
      const [stateRoot, annotationRoot] = await Promise.all([
        realpath(paths.directory),
        realpath(paths.annotationDirectory),
      ]);
      const relative = path.relative(stateRoot, annotationRoot);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error("The annotation directory escapes private state");
    },
    catch: storeFailure,
  });
}

function readStoreFile(
  paths: StatePaths,
): Effect.Effect<Buffer | undefined, RuntimeStateError> {
  return Effect.try({
    try: () => {
      let descriptor: number;
      try {
        descriptor = openSync(
          paths.annotationFile,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      try {
        const metadata = fstatSync(descriptor);
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          metadata.size > maximumAnnotationStoreBytes ||
          (metadata.mode & 0o777) !== 0o600 ||
          (process.getuid !== undefined && metadata.uid !== process.getuid())
        )
          throw new Error(
            "The annotation state file is not a private regular file",
          );
        const body = Buffer.alloc(metadata.size);
        let offset = 0;
        while (offset < body.length) {
          const count = readSync(
            descriptor,
            body,
            offset,
            body.length - offset,
            offset,
          );
          if (count === 0) break;
          offset += count;
        }
        if (offset !== body.length)
          throw new Error("The annotation state file changed while reading");
        const finalMetadata = fstatSync(descriptor);
        if (
          finalMetadata.dev !== metadata.dev ||
          finalMetadata.ino !== metadata.ino ||
          finalMetadata.size !== metadata.size
        )
          throw new Error("The annotation state file changed while reading");
        return body;
      } finally {
        closeSync(descriptor);
      }
    },
    catch: storeFailure,
  });
}

function removeStaleTemporaryFiles(
  paths: StatePaths,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.tryPromise({
    try: async () => {
      const names = await readdir(paths.annotationDirectory);
      const prefix = `${path.basename(paths.annotationFile)}.`;
      const stale = names.filter((name) => {
        if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
        return /^[1-9][0-9]*\.[0-9a-f]{16}$/.test(
          name.slice(prefix.length, -".tmp".length),
        );
      });
      await Promise.all(
        stale.map((name) => unlink(path.join(paths.annotationDirectory, name))),
      );
    },
    catch: storeFailure,
  });
}

async function assertValidDestination(paths: StatePaths): Promise<void> {
  try {
    const metadata = await lstat(paths.annotationFile);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())
    )
      throw new Error("The annotation state destination is not private");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeSnapshot(
  paths: StatePaths,
  value: unknown,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const body = Buffer.from(JSON.stringify(value));
        if (body.length > maximumAnnotationStoreBytes)
          throw new Error("The annotation snapshot exceeds its size limit");
        const temporary = `${paths.annotationFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
        let descriptor: Awaited<ReturnType<typeof open>> | undefined;
        let renamed = false;
        try {
          descriptor = await open(
            temporary,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          const metadata = await descriptor.stat();
          if (
            !metadata.isFile() ||
            metadata.nlink !== 1 ||
            (process.getuid !== undefined && metadata.uid !== process.getuid())
          )
            throw new Error("The annotation temporary file is not private");
          await descriptor.chmod(0o600);
          let offset = 0;
          while (offset < body.length) {
            const result = await descriptor.write(
              body,
              offset,
              body.length - offset,
              offset,
            );
            if (result.bytesWritten === 0)
              throw new Error("Annotation snapshot write made no progress");
            offset += result.bytesWritten;
          }
          await descriptor.sync();
          await descriptor.close();
          descriptor = undefined;
          await assertValidDestination(paths);
          await rename(temporary, paths.annotationFile);
          renamed = true;
          const directory = await open(
            paths.annotationDirectory,
            constants.O_RDONLY,
          );
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          if (descriptor !== undefined)
            await descriptor.close().catch(() => undefined);
          if (!renamed)
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
        }
      },
      catch: storeFailure,
    }),
  );
}

function recoverAnnotationState(
  state: AnnotationState,
  now: Date,
): { readonly state: AnnotationState; readonly changed: boolean } {
  let changed = false;
  const reviews = state.reviews.map((review) => {
    if (review.status !== "ready") return review;
    changed = true;
    return { ...review, status: "stopped" as const };
  });
  const tombstones = state.tombstones.filter((tombstone) => {
    const retained = Date.parse(tombstone.expiresAt) > now.getTime();
    if (!retained) changed = true;
    return retained;
  });
  return {
    state: changed ? { ...state, reviews, tombstones } : state,
    changed,
  };
}

export function saveAnnotationState(
  paths: StatePaths,
  state: AnnotationState,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.gen(function* () {
    yield* ensureAnnotationDirectory(paths);
    if (!annotationStateIsConsistent(state))
      return yield* storeFailure(
        new Error("Annotation state invariants failed"),
      );
    const encoded = yield* Effect.try({
      try: () => Schema.encodeSync(AnnotationStateSchema, strict)(state),
      catch: storeFailure,
    });
    if (!annotationStateFitsStorageBounds(encoded))
      return yield* storeFailure(
        new Error("The persisted annotation state exceeds its size limit"),
      );
    yield* writeSnapshot(paths, encoded);
  });
}

export function loadAnnotationState(
  paths: StatePaths,
  now = new Date(),
): Effect.Effect<AnnotationState, RuntimeStateError> {
  return Effect.gen(function* () {
    yield* ensureAnnotationDirectory(paths);
    yield* removeStaleTemporaryFiles(paths);
    const body = yield* readStoreFile(paths);
    if (body === undefined) return emptyAnnotationState();
    const decoded = yield* Effect.try({
      try: () =>
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(body),
        ) as unknown,
      catch: storeFailure,
    });
    const result = decodeAnnotationState(decoded);
    if (Result.isFailure(result)) return yield* storeFailure(result.failure);
    if (!annotationStateIsConsistent(result.success))
      return yield* storeFailure(
        new Error("Annotation state invariants failed"),
      );
    const recovered = recoverAnnotationState(result.success, now);
    if (recovered.changed) yield* saveAnnotationState(paths, recovered.state);
    return recovered.state;
  });
}
