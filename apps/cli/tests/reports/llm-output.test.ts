import { describe, expect, test } from "bun:test";

import {
  sampleAffectedPagesBreadthFirst,
  serializeMetaValue,
} from "../../src/reports/output/llm";

describe("sampleAffectedPagesBreadthFirst", () => {
  test("prefers shallower URLs first", () => {
    const pages = [
      "https://example.com/a/b/c",
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/a/b",
      "https://example.com/z",
      "https://example.com/z/y",
    ];

    const sampled = sampleAffectedPagesBreadthFirst(
      pages,
      "https://example.com"
    );
    expect(sampled).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/z",
      "https://example.com/a/b",
      "https://example.com/z/y",
    ]);
  });

  test("deduplicates and caps at max size", () => {
    const pages = [
      "https://example.com/",
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ];

    const sampled = sampleAffectedPagesBreadthFirst(
      pages,
      "https://example.com",
      3
    );
    expect(sampled).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});

describe("serializeMetaValue", () => {
  test("serializes objects as JSON instead of [object Object]", () => {
    const value = serializeMetaValue({ a: 1, b: "x" });
    expect(value).toContain('"a":1');
    expect(value).toContain('"b":"x"');
    expect(value).not.toBe("[object Object]");
  });

  test("returns primitive values as strings", () => {
    expect(serializeMetaValue(42)).toBe("42");
    expect(serializeMetaValue(true)).toBe("true");
    expect(serializeMetaValue("hello")).toBe("hello");
  });
});
