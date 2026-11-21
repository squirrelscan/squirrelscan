// squirrelscan/repo#3368: an unknown status (including prototype names) ranks last, never NaN.

import { describe, expect, test } from "bun:test";

import { statusRank } from "../src/publish-cap";

describe("publish cap statusRank own-property lookup (#3368)", () => {
  const unknown = statusRank("no-such-status");

  for (const name of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ]) {
    test(`${name} ranks like an unknown status`, () => {
      expect(statusRank(name)).toBe(unknown);
      expect(Number.isNaN(statusRank(name))).toBe(false);
    });
  }

  test("known statuses keep their order", () => {
    expect(["fail", "warn", "info", "skipped", "pass"].map(statusRank)).toEqual(
      [0, 1, 2, 3, 4]
    );
    expect(unknown).toBe(5);
  });
});
