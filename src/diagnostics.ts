import { Effect, Layer, Logger } from "effect";
import {
  contentListenerErrorCodes,
  controlErrorCodes,
  pathErrorCodes,
  runtimeStateErrorCodes,
  supervisorErrorCodes,
  type OperationalError,
} from "./errors.js";

const diagnosticOperations = [
  "cli.home",
  "cli.serve",
  "cli.stop",
  "cli.runtime",
  "supervisor.run",
  "state.cleanup",
  "http.cleanup",
] as const;

const diagnosticCodes = [
  "runtime.internal",
  ...pathErrorCodes,
  ...runtimeStateErrorCodes,
  ...controlErrorCodes,
  ...supervisorErrorCodes,
  ...contentListenerErrorCodes,
] as const;

export type DiagnosticOperation = (typeof diagnosticOperations)[number];
export type DiagnosticCode = OperationalError["code"] | "runtime.internal";

export interface DiagnosticEvent {
  readonly operation: DiagnosticOperation;
  readonly code?: DiagnosticCode;
  readonly internalId?: string;
  readonly durationMilliseconds?: number;
  readonly itemCount?: number;
  readonly failureCount?: number;
}

export type DiagnosticLevel =
  "Trace" | "Debug" | "Info" | "Warn" | "Error" | "Fatal";

const operationSet = new Set<string>(diagnosticOperations);
const codeSet = new Set<string>(diagnosticCodes);
const maximumDiagnosticCount = 1_000_000;
const maximumDiagnosticDurationMilliseconds = 86_400_000;
const internalIdPattern = /^[A-Za-z0-9_-]{16,64}$/;

function boundedInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function decodeDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== "operation" &&
        key !== "code" &&
        key !== "internalId" &&
        key !== "durationMilliseconds" &&
        key !== "itemCount" &&
        key !== "failureCount",
    ) ||
    typeof record.operation !== "string" ||
    !operationSet.has(record.operation) ||
    (record.code !== undefined &&
      (typeof record.code !== "string" || !codeSet.has(record.code))) ||
    (record.internalId !== undefined &&
      (typeof record.internalId !== "string" ||
        !internalIdPattern.test(record.internalId))) ||
    (record.durationMilliseconds !== undefined &&
      !boundedInteger(
        record.durationMilliseconds,
        maximumDiagnosticDurationMilliseconds,
      )) ||
    (record.itemCount !== undefined &&
      !boundedInteger(record.itemCount, maximumDiagnosticCount)) ||
    (record.failureCount !== undefined &&
      !boundedInteger(record.failureCount, maximumDiagnosticCount))
  )
    return undefined;
  return record as unknown as DiagnosticEvent;
}

function serializedDiagnostic(
  date: Date,
  level: string,
  message: unknown,
): string | undefined {
  const values = Array.isArray(message) ? message : [message];
  if (values.length !== 1) return undefined;
  const event = decodeDiagnosticEvent(values[0]);
  if (event === undefined) return undefined;
  return JSON.stringify({
    timestamp: date.toISOString(),
    level: level.toLowerCase(),
    operation: event.operation,
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.internalId === undefined
      ? {}
      : { internal_id: event.internalId }),
    ...(event.durationMilliseconds === undefined
      ? {}
      : { duration_ms: event.durationMilliseconds }),
    ...(event.itemCount === undefined ? {} : { item_count: event.itemCount }),
    ...(event.failureCount === undefined
      ? {}
      : { failure_count: event.failureCount }),
  });
}

export function makeDiagnosticLogger(
  sink: (line: string) => void,
): Logger.Logger<unknown, void> {
  return Logger.make(({ date, logLevel, message }) => {
    const line = serializedDiagnostic(date, logLevel, message);
    if (line !== undefined) sink(line);
  });
}

export function foregroundDiagnosticLayer(
  stderr: (line: string) => void,
): Layer.Layer<never> {
  return Layer.mergeAll(
    Logger.layer([makeDiagnosticLogger(stderr)]),
    Layer.succeed(Logger.LogToStderr, true),
  );
}

export function logDiagnostic(
  level: DiagnosticLevel,
  event: DiagnosticEvent,
): Effect.Effect<void> {
  return Effect.logWithLevel(level)(event);
}
