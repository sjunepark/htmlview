import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { decode, encode } from "@toon-format/toon";
import { decodeOutput, serialize } from "../src/output.js";
import type { JsonObject, OutputFormat } from "../src/contracts.js";

interface FixtureCase {
  name: string;
  input: unknown;
  expected: unknown;
  options?: Record<string, unknown>;
  shouldError?: boolean;
}

interface FixtureFile {
  tests: FixtureCase[];
}

const fixtureRoot = path.resolve(
  "node_modules/@toon-format/spec/tests/fixtures",
);

async function fixtureFiles(category: "encode" | "decode"): Promise<string[]> {
  const directory = path.join(fixtureRoot, category);
  return (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(directory, file));
}

describe("TOON v3.3 conformance fixtures", () => {
  it("passes every encoder fixture", async () => {
    for (const file of await fixtureFiles("encode")) {
      const fixture = JSON.parse(await readFile(file, "utf8")) as FixtureFile;
      for (const testCase of fixture.tests) {
        const actual = encode(testCase.input, testCase.options);
        assert.equal(
          actual,
          testCase.expected,
          `${path.basename(file)}: ${testCase.name}`,
        );
      }
    }
  });

  it("passes every decoder fixture", async () => {
    for (const file of await fixtureFiles("decode")) {
      const fixture = JSON.parse(await readFile(file, "utf8")) as FixtureFile;
      for (const testCase of fixture.tests) {
        const operation = () =>
          decode(testCase.input as string, testCase.options);
        if (testCase.shouldError === true) {
          assert.throws(operation, `${path.basename(file)}: ${testCase.name}`);
        } else {
          assert.deepEqual(
            operation(),
            testCase.expected,
            `${path.basename(file)}: ${testCase.name}`,
          );
        }
      }
    }
  });

  it("round-trips output-injection characters", () => {
    const value = {
      path: "dir/a,b|c: d\nline\tcontrol\u0001",
      unicode: "한글/雪/😀",
      terminal: "\u001b[31mred\u001b[0m",
      rows: [
        { id: "a,b", status: "ready" },
        { id: "x|y", status: "ready" },
      ],
    };
    assert.deepEqual(decode(encode(value)), value);
  });

  it("guards quoted structural sequences rejected by the reference decoder", () => {
    const value = { message: "[]:" };
    assert.deepEqual(decodeOutput(serialize(value, "toon"), "toon"), value);
  });

  it("preserves generated hostile values and result shape in both formats", () => {
    let state = 0x5eed1234;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const alphabet = [
      ",",
      "|",
      ":",
      "[",
      "]",
      "{",
      "}",
      '"',
      "'",
      "\\",
      "\n",
      "\r",
      "\t",
      "\0",
      "\u0001",
      "\u001b",
      "雪",
      "한",
      "😀",
      "%2e%2e",
    ];
    for (let index = 0; index < 500; index += 1) {
      let generated = "";
      const length = next() % 80;
      for (let offset = 0; offset < length; offset += 1)
        generated += alphabet[next() % alphabet.length];
      const value: JsonObject = {
        error: {
          code: `generated.${index}`,
          message: generated,
          path: `/tmp/${generated}`,
        },
        rows: [
          { id: generated, status: "ready" },
          { id: `suffix-${index}`, status: "ready" },
        ],
        count: 2,
      };
      for (const format of ["toon", "json"] as OutputFormat[]) {
        assert.deepEqual(
          decodeOutput(serialize(value, format), format),
          value,
          `${format} generated case ${index}`,
        );
      }
    }
  });
});
