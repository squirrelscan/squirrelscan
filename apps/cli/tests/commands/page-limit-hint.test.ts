// Tests for the page-limit-reached hint (issue #124).

import { MAX_PAGES_CAP } from "@squirrelscan/core-contracts/limits";
import { describe, expect, test } from "bun:test";

import { pageLimitHint } from "../../src/cli/format";

describe("pageLimitHint", () => {
  test("returns null when the limit was not reached", () => {
    expect(pageLimitHint(false, 100)).toBeNull();
    expect(pageLimitHint(false, 25)).toBeNull();
  });

  test("hints with the override and cap when the limit is hit", () => {
    const hint = pageLimitHint(true, 100);
    expect(hint).not.toBeNull();
    expect(hint).toContain("Reached max pages (100)");
    expect(hint).toContain("--max-pages <N>");
    expect(hint).toContain("[crawler] max_pages");
    expect(hint).toContain(`cap ${MAX_PAGES_CAP}`);
    expect(hint).toContain("-C full");
  });

  test("uses the cap-specific wording at the hard cap", () => {
    const hint = pageLimitHint(true, MAX_PAGES_CAP);
    expect(hint).not.toBeNull();
    expect(hint).toContain(`Reached the max pages cap (${MAX_PAGES_CAP})`);
    expect(hint).toContain("hard limit");
    // Don't tell users to raise past the cap.
    expect(hint).not.toContain("--max-pages <N>");
  });
});
