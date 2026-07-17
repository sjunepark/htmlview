import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Data, Effect, type Scope } from "effect";
import { logDiagnostic } from "../diagnostics.js";
import { isWithinRoot } from "./grant.js";

type FileHandle = Awaited<ReturnType<typeof open>>;

interface OwnedFileHandle {
  readonly handle: FileHandle;
  streamCreated: boolean;
  transferredToStream: boolean;
}

class FileAccessError extends Data.TaggedError("FileAccessError")<{
  readonly cause: unknown;
}> {}

export interface AuthorizedFileMetadata {
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly inode: bigint;
}

export type AuthorizedFile =
  | { readonly outcome: "missing" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "changed" }
  | {
      readonly outcome: "file";
      readonly metadata: AuthorizedFileMetadata;
      readonly openReadStream: Effect.Effect<Readable, never, Scope.Scope>;
    };

function reportCleanupFailure(): Effect.Effect<void> {
  return logDiagnostic("Error", {
    operation: "http.cleanup",
    code: "runtime.internal",
    failureCount: 1,
  });
}

function closeOwnedFile(owned: OwnedFileHandle): Effect.Effect<void> {
  if (owned.transferredToStream) return Effect.void;
  return Effect.tryPromise({
    try: () => owned.handle.close(),
    catch: (cause) => new FileAccessError({ cause }),
  }).pipe(
    Effect.catch(() => reportCleanupFailure()),
    Effect.asVoid,
  );
}

function optionalFilePromise<A>(
  operation: () => Promise<A>,
): Effect.Effect<A | undefined> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new FileAccessError({ cause }),
  }).pipe(Effect.catch(() => Effect.sync((): undefined => undefined)));
}

function takeReadStream(owned: OwnedFileHandle, size: bigint): Readable {
  if (owned.streamCreated)
    throw new Error("The authorized file stream was already created");
  owned.streamCreated = true;
  if (size === 0n) return Readable.from([]);
  const stream = owned.handle.createReadStream({
    autoClose: true,
    end: Number(size - 1n),
  });
  owned.transferredToStream = true;
  return stream;
}

function acquireReadStream(
  owned: OwnedFileHandle,
  size: bigint,
): Effect.Effect<Readable, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => takeReadStream(owned, size)),
    (stream) =>
      Effect.sync(() => {
        if (!stream.destroyed) stream.destroy();
      }),
  );
}

export function openAuthorizedFile(
  root: string,
  target: string,
): Effect.Effect<AuthorizedFile, never, Scope.Scope> {
  return Effect.gen(function* () {
    const resolved = yield* optionalFilePromise(() => realpath(target));
    if (resolved === undefined || resolved === root)
      return { outcome: "missing" };
    if (!isWithinRoot(root, resolved)) return { outcome: "forbidden" };

    const owned = yield* Effect.acquireRelease(
      optionalFilePromise(() =>
        open(resolved, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK),
      ).pipe(
        Effect.flatMap((handle) =>
          handle === undefined
            ? Effect.fail(undefined)
            : Effect.succeed({
                handle,
                streamCreated: false,
                transferredToStream: false,
              }),
        ),
      ),
      closeOwnedFile,
    ).pipe(Effect.catch(() => Effect.void));
    if (owned === undefined) return { outcome: "missing" };

    const openedMetadata = yield* optionalFilePromise(() =>
      owned.handle.stat({ bigint: true }),
    );
    if (openedMetadata === undefined || !openedMetadata.isFile())
      return { outcome: "missing" };

    const resolvedAfterOpen = yield* optionalFilePromise(() =>
      realpath(resolved),
    );
    if (resolvedAfterOpen === undefined) return { outcome: "missing" };
    if (!isWithinRoot(root, resolvedAfterOpen)) return { outcome: "forbidden" };

    const currentMetadata = yield* optionalFilePromise(() =>
      stat(resolvedAfterOpen, { bigint: true }),
    );
    if (currentMetadata === undefined) return { outcome: "missing" };
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino
    )
      return { outcome: "changed" };

    const metadata: AuthorizedFileMetadata = {
      size: openedMetadata.size,
      modifiedNanoseconds: openedMetadata.mtimeNs,
      inode: openedMetadata.ino,
    };
    return {
      outcome: "file",
      metadata,
      openReadStream: acquireReadStream(owned, metadata.size),
    };
  });
}
