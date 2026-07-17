import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Effect, Layer, Logger, References } from "effect";
import { makeDiagnosticLogger } from "../diagnostics.js";
import { RuntimeStateError } from "../errors.js";
import { ensurePrivateStateDirectory, type StatePaths } from "./state.js";

export const maximumSupervisorLogBytes = 64 * 1024;
export const maximumSupervisorLogFiles = 3;

function logFailure(cause: unknown): RuntimeStateError {
  return new RuntimeStateError({
    code: "state.unavailable",
    message: "The private htmlview supervisor log is unavailable",
    reason: "unavailable",
    cause,
  });
}

function assertPrivateDirectory(directory: string): void {
  const linkMetadata = lstatSync(directory);
  const metadata = statSync(directory);
  if (linkMetadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error("Supervisor log path is not a private directory");
  if (process.getuid !== undefined && metadata.uid !== process.getuid())
    throw new Error("Supervisor log directory has a different owner");
}

function assertPrivateFileDescriptor(descriptor: number): void {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile())
    throw new Error("Supervisor log path is not a regular file");
  if (process.getuid !== undefined && metadata.uid !== process.getuid())
    throw new Error("Supervisor log file has a different owner");
  fchmodSync(descriptor, 0o600);
}

function openPrivateLog(file: string): number {
  const descriptor = openSync(
    file,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    assertPrivateFileDescriptor(descriptor);
    return descriptor;
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

function rotatedFile(file: string, generation: number): string {
  return `${file}.${generation}`;
}

function recognizedGeneration(file: string, name: string): number | undefined {
  const prefix = `${path.basename(file)}.`;
  if (!name.startsWith(prefix)) return undefined;
  const suffix = name.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return undefined;
  return Number(suffix);
}

function prepareLogFiles(paths: StatePaths): void {
  mkdirSync(paths.diagnosticLogDirectory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(paths.diagnosticLogDirectory);
  chmodSync(paths.diagnosticLogDirectory, 0o700);

  for (const name of readdirSync(paths.diagnosticLogDirectory)) {
    const generation = recognizedGeneration(paths.diagnosticLogFile, name);
    if (generation === undefined) continue;
    const file = path.join(paths.diagnosticLogDirectory, name);
    if (generation >= maximumSupervisorLogFiles) {
      rmSync(file, { force: true });
      continue;
    }
    const metadata = lstatSync(file);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())
    )
      throw new Error("Supervisor log generation is not a private file");
    if (metadata.size > maximumSupervisorLogBytes)
      rmSync(file, { force: true });
    else chmodSync(file, 0o600);
  }

  let descriptor = openPrivateLog(paths.diagnosticLogFile);
  try {
    if (fstatSync(descriptor).size > maximumSupervisorLogBytes) {
      closeSync(descriptor);
      descriptor = -1;
      rmSync(paths.diagnosticLogFile, { force: true });
      descriptor = openPrivateLog(paths.diagnosticLogFile);
    }
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function rotateLogs(file: string): void {
  rmSync(rotatedFile(file, maximumSupervisorLogFiles - 1), { force: true });
  for (
    let generation = maximumSupervisorLogFiles - 2;
    generation >= 1;
    generation -= 1
  ) {
    const source = rotatedFile(file, generation);
    try {
      renameSync(source, rotatedFile(file, generation + 1));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  try {
    renameSync(file, rotatedFile(file, 1));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

function appendLogLine(file: string, line: string): void {
  const bytes = Buffer.from(`${line}\n`);
  if (bytes.length > maximumSupervisorLogBytes) return;

  let descriptor = openPrivateLog(file);
  try {
    if (fstatSync(descriptor).size + bytes.length > maximumSupervisorLogBytes) {
      closeSync(descriptor);
      descriptor = -1;
      rotateLogs(file);
      descriptor = openPrivateLog(file);
    }
    writeFileSync(descriptor, bytes);
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function prepareSupervisorLog(
  paths: StatePaths,
): Effect.Effect<(line: string) => void, RuntimeStateError> {
  return ensurePrivateStateDirectory(paths).pipe(
    Effect.andThen(
      Effect.try({
        try: () => {
          prepareLogFiles(paths);
          return (line: string): void => {
            try {
              appendLogLine(paths.diagnosticLogFile, line);
            } catch {
              // Logging must not replace the supervisor's operational outcome.
            }
          };
        },
        catch: logFailure,
      }),
    ),
  );
}

export function supervisorDiagnosticLayer(
  paths: StatePaths,
): Layer.Layer<never, RuntimeStateError> {
  return Layer.unwrap(
    prepareSupervisorLog(paths).pipe(
      Effect.map((sink) =>
        Layer.mergeAll(
          Logger.layer([makeDiagnosticLogger(sink)]),
          Layer.succeed(Logger.LogToStderr, true),
          Layer.succeed(References.MinimumLogLevel, "Info"),
        ),
      ),
    ),
  );
}
