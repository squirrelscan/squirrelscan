// squirrelscan/repo#3368: category codes come from user config, so prototype names must pass through unchanged.

import { describe, expect, test } from "bun:test";

import { normalizeCategoryCode } from "../src/index";

describe("normalizeCategoryCode own-property lookup (#3368)", () => {
  for (const name of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    test(`${name} is returned unchanged, like an unknown code`, () => {
      expect(normalizeCategoryCode(name)).toBe(name);
      expect(normalizeCategoryCode("unknown-code")).toBe("unknown-code");
    });
  }

  test("known aliases still map", () => {
    expect(normalizeCategoryCode("adblock")).toBe("blocking");
    expect(normalizeCategoryCode("ai")).toBe("ax");
    expect(normalizeCategoryCode("seo")).toBe("seo");
  });
});
