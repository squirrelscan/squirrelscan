// #1909: a page request above the cap must be clamped AND said out loud.
//
// The bug was not the clamp, it was the silence. `squirrel audit --max-pages
// 10000` crawled 5,000 and reported `maxPages: 5000`, which is exactly what a
// 5,000-page site reports, so there was no way to tell the two apart. The
// neighbouring notice in cli/format.ts fires when a crawl REACHES the cap,
// which is a different event: a 10,000-page request against a 4,000-page site
// was clamped and never mentioned.

import { describe, expect, test } from "bun:test";

import { MAX_PAGES_CAP } from "@squirrelscan/core-contracts/limits";

import { pageLimitNotice, resolvePageLimit } from "@/lib/page-limit";

describe("resolvePageLimit", () => {
  test("clamps above the cap and records what was asked for", () => {
    const limit = resolvePageLimit(10_000);
    expect(limit.effective).toBe(MAX_PAGES_CAP);
    expect(limit.requested).toBe(10_000);
    expect(limit.clamped).toBe(true);
  });

  test("leaves a request at or below the cap alone", () => {
    for (const requested of [1, 100, MAX_PAGES_CAP - 1, MAX_PAGES_CAP]) {
      const limit = resolvePageLimit(requested);
      expect(limit.effective).toBe(requested);
      expect(limit.clamped).toBe(false);
    }
  });

  test("the cap itself is not a clamp", () => {
    // Off-by-one guard: `effective < requested` rather than `<=`, or every
    // full-size audit would print a notice about not being clamped.
    expect(resolvePageLimit(MAX_PAGES_CAP).clamped).toBe(false);
    expect(resolvePageLimit(MAX_PAGES_CAP + 1).clamped).toBe(true);
  });

  test("passes a rejected value through rather than coercing it", () => {
    // The commands reject NaN and non-positive values with a message naming the
    // flag. Turning them into the cap here would hide that and crawl 5,000
    // pages for someone who typed `--max-pages abc`.
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const limit = resolvePageLimit(bad);
      expect(limit.clamped).toBe(false);
      expect(Object.is(limit.effective, bad)).toBe(true);
    }
  });
});

describe("pageLimitNotice", () => {
  test("names both numbers when the cap bound", () => {
    const notice = pageLimitNotice(resolvePageLimit(10_000));
    expect(notice).toBeTruthy();
    expect(notice).toContain("10,000");
    expect(notice).toContain(MAX_PAGES_CAP.toLocaleString("en-US"));
  });

  test("says nothing when it did not", () => {
    expect(pageLimitNotice(resolvePageLimit(100))).toBeNull();
    expect(pageLimitNotice(resolvePageLimit(MAX_PAGES_CAP))).toBeNull();
  });

  test("does not name the flag, because config reaches the same clamp", () => {
    // `[crawler] max_pages = 9000` produces this notice too, and telling that
    // user to change `--max-pages` would send them to the wrong place.
    const notice = pageLimitNotice(resolvePageLimit(9_000)) ?? "";
    expect(notice).not.toContain("--max-pages");
  });
});
