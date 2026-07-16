import { decode, encode } from "@toon-format/toon";
import type { JsonValue, OutputFormat } from "./contracts.js";

const quotedStructuralEscapes: Record<string, string> = {
  "[": "\\u005b",
  "]": "\\u005d",
  "{": "\\u007b",
  "}": "\\u007d",
  ":": "\\u003a",
  ",": "\\u002c",
  "|": "\\u007c",
};

function hardenQuotedToonStrings(value: string): string {
  let result = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === '"') {
      quoted = !quoted;
      result += character;
      continue;
    }
    if (quoted && character === "\\") {
      result += character;
      index += 1;
      result += value[index] ?? "";
      continue;
    }
    result += quoted
      ? (quotedStructuralEscapes[character] ?? character)
      : character;
  }
  return result;
}

export function serialize(value: JsonValue, format: OutputFormat): string {
  return format === "json"
    ? JSON.stringify(value)
    : hardenQuotedToonStrings(encode(value));
}

export function decodeOutput(value: string, format: OutputFormat): JsonValue {
  return (format === "json" ? JSON.parse(value) : decode(value)) as JsonValue;
}
