import { decode, encode } from "@toon-format/toon";
import type { JsonValue, OutputFormat } from "./contracts.js";

export function serialize(value: JsonValue, format: OutputFormat): string {
  return format === "json" ? JSON.stringify(value) : encode(value);
}

export function decodeOutput(value: string, format: OutputFormat): JsonValue {
  return (format === "json" ? JSON.parse(value) : decode(value)) as JsonValue;
}
