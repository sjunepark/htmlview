export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type OutputFormat = "json" | "toon";

export function errorResult(
  code: string,
  message: string,
  details: JsonObject = {},
  help: string[] = [],
): JsonObject {
  const result: JsonObject = {
    error: { ...details, code, message },
  };
  if (help.length > 0) result.help = help;
  return result;
}
