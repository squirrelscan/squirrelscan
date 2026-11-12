// A per-page measurement alone in parentheses merges into a range, a limit never does (#1767).

import { describe, expect, test } from "bun:test";

import { mergeCheckMessages } from "@squirrelscan/core-contracts/message-merge";

describe("measurements in parentheses", () => {
  test("two timings become one range, a year-sized value included", () => {
    expect(mergeCheckMessages(["Slow server response (850ms)", "Slow server response (1200ms)"])).toBe(
      "Slow server response (850 to 1200ms)",
    );
    expect(mergeCheckMessages(["HTML cache appropriate (3s)", "HTML cache appropriate (17s)"])).toBe(
      "HTML cache appropriate (3 to 17s)",
    );
    // The same value on every page keeps its original text.
    expect(mergeCheckMessages(["Slow server response (850ms)", "Slow server response (850ms)"])).toBe(
      "Slow server response (850ms)",
    );
  });

  test("a limit or a threshold stays a statement and never widens", () => {
    for (const [a, b] of [
      ["3 large inline SVG(s) (>3KB each)", "17 large inline SVG(s) (>3KB each)"],
      ["PDF exceeds the 3MB error threshold", "PDF exceeds the 5MB error threshold"],
      ["HTML is 3MB, over the Googlebot 15MB limit", "HTML is 5MB, over the Googlebot 15MB limit"],
    ] as const) {
      const merged = mergeCheckMessages([a, b]);
      expect(merged === null || !/\d+ to \d+(KB|MB)/.test(merged)).toBe(true);
    }
  });

  test("a different unit is a different claim and does not merge", () => {
    expect(mergeCheckMessages(["Slow server response (850ms)", "Slow server response (2s)"])).toBeNull();
  });
});
