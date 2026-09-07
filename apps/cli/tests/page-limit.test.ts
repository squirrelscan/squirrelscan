// #1909: a page request above the cap must be clamped AND said out loud.
//
// The bug was not the clamp, it was the silence. `squirrel audit --max-pages
// 10000` crawled 5,000 and reported `maxPages: 5000`, which is exactly what a
// 5,000-page site reports, so there was no way to tell the two apart. The
// neighbouring notice in cli/format.ts fires when a crawl REACHES the cap,
// which is a different event: a 10,000-page request against a 4,000-page site
// was clamped and never mentioned.

import { MAX_PAGES_CAP } from "@squirrelscan/core-contracts/limits";
import { describe, expect, test } from "bun:test";

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

  test("NEVER returns an effective limit above the cap", () => {
    // The regression this exists to stop. A first version passed non-finite and
    // non-positive requests through untouched, so `[crawler] max_pages = inf`
    // — which the config schema accepts, and which never reaches the flag
    // validation — sent Infinity to the crawler and the hard cap stopped being
    // hard. `effective` is `Math.min` for every input, as it was before.
    for (const value of [Number.POSITIVE_INFINITY, 1e12, MAX_PAGES_CAP * 2]) {
      expect(resolvePageLimit(value).effective).toBe(MAX_PAGES_CAP);
      expect(resolvePageLimit(value).clamped).toBe(true);
    }
  });

  test("leaves the strange inputs exactly where Math.min left them", () => {
    // Not this change's job to fix: `crawl` does no flag validation at all, so
    // its NaN and zero behaviour is pre-existing, and quietly turning either
    // into 5,000 here would be a new bug wearing a fix's clothes.
    expect(Number.isNaN(resolvePageLimit(Number.NaN).effective)).toBe(true);
    expect(resolvePageLimit(Number.NaN).clamped).toBe(false);
    expect(resolvePageLimit(0).effective).toBe(0);
    expect(resolvePageLimit(-5).effective).toBe(-5);
    expect(resolvePageLimit(-5).clamped).toBe(false);
  });
});

describe("pageLimitNotice", () => {
  test("says 'unlimited' rather than a rendering artefact for Infinity", () => {
    const notice =
      pageLimitNotice(resolvePageLimit(Number.POSITIVE_INFINITY)) ?? "";
    expect(notice).toContain("unlimited pages");
    expect(notice).not.toContain("∞");
  });

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
