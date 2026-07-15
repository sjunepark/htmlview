export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type OutputFormat = "json" | "toon";
export type OptionalSessionField = "entry" | "root";

export interface SessionSummary extends JsonObject {
  id: string;
  status: "ready";
  url: string;
  entry?: string;
  root?: string;
}

export interface UsageFailure {
  readonly exitCode: 2;
  readonly result: JsonObject;
}

export interface RuntimeFailure {
  readonly exitCode: 1;
  readonly result: JsonObject;
}

export type Failure = UsageFailure | RuntimeFailure;

export function errorResult(
  code: string,
  message: string,
  details: JsonObject = {},
  help: string[] = [],
): JsonObject {
  const result: JsonObject = {
    error: { code, message, ...details },
  };
  if (help.length > 0) result.help = help;
  return result;
}
