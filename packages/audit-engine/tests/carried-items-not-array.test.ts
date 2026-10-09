// A carried payload whose `items` is not an array must not reach the fold as
// items: foldGroup iterates them and a non-iterable value throws, aborting the
// publish merge (#504).

import { describe, expect, test } from "bun:test";

import { DEFAULT_FOLD_LIMITS, foldOverflowChecks } from "@squirrelscan/rules/fold";

import { carriedFindingToCheck, type CarriedFinding } from "../src/scoring";

function carried(payload: string): CarriedFinding {
  return {
    normalizedUrl: "https://example.com/a",
    ruleId: "core/meta-title",
    checkName: "meta-title-length",
    status: "warn",
    message: "Title is too long",
    payload,
  };
}

describe("carriedFindingToCheck with a malformed payload items (#504)", () => {
  test.each([
    ["a number", '{"items":3}'],
    ["true", '{"items":true}'],
    ["an object", '{"items":{"length":3}}'],
  ])("items that is %s is not replayed", (_label, payload) => {
    const check = carriedFindingToCheck(carried(payload), "https://example.com/a");
    expect(check.items).toBeUndefined();
  });

  test("a well-formed items array is still replayed", () => {
    const items = [{ id: "x", label: "x" }];
    const check = carriedFindingToCheck(
      carried(JSON.stringify({ items })),
      "https://example.com/a",
    );
    expect(check.items).toEqual(items);
  });

  test("folding an over-budget rule that holds a malformed row does not throw", () => {
    const checks = [
      carriedFindingToCheck(carried('{"items":3}'), "https://example.com/a"),
      carriedFindingToCheck(carried('{"items":3}'), "https://example.com/b"),
      carriedFindingToCheck(carried('{"items":{"length":3}}'), "https://example.com/c"),
    ];
    expect(() => foldOverflowChecks(checks, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 })).not.toThrow();
  });
});
