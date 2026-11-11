// pub#1767: a folded check never states one page's problem for every page.
// One image on 16 pages reads "1 image ..., shown on 16 pages", not "1 image(s) ... (+15 more pages)";
// pages that disagree are listed with their page counts; the aggregate carries the distinct item count.

import { describe, expect, test } from "bun:test";

import type { ImageData } from "@squirrelscan/core-contracts";

import { DEFAULT_FOLD_LIMITS, foldOverflowChecks, unfoldAggregateCheck, type FoldLimits } from "../src/fold";
import { validateImages } from "../src/images/images";
import type { CheckResult } from "../src/types";

const LIMITS: FoldLimits = { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 };

const page = (i: number) => `https://shop.test/p/${i}`;
const image = (src: string): ImageData => ({ src, alt: null, width: 10, height: 10 }) as unknown as ImageData;

/** The check the real images rule emits for one page whose images all lack alt. */
function missingAlt(url: string, srcs: string[]): CheckResult {
  const check = validateImages(srcs.map(image)).find((c) => c.name === "image-alt")!;
  return { ...check, pageUrl: url };
}

const fold = (checks: CheckResult[], limits = LIMITS) => {
  const out = foldOverflowChecks(checks, limits);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe("one distinct item on many pages", () => {
  test("names the unit and the reach, without (+N more pages)", () => {
    const agg = fold(Array.from({ length: 16 }, (_, i) => missingAlt(page(i), ["/img/hero.jpg"])));
    expect(agg.message).toBe("1 image missing alt attribute, shown on 16 pages");
    expect(agg.message).not.toContain("more pages");
    expect(agg.details?.distinctItems).toBe(1);
    expect(agg.details?.occurrences).toBe(16);
  });
});

describe("many items on many pages", () => {
  test("states the distinct items and the pages", () => {
    // 14 distinct images spread over 9 pages: page i carries images i and i+9 (when they exist).
    const checks = Array.from({ length: 9 }, (_, i) =>
      missingAlt(page(i), i + 9 < 14 ? [`/img/${i}.jpg`, `/img/${i + 9}.jpg`] : [`/img/${i}.jpg`]),
    );
    const agg = fold(checks);
    expect(agg.message).toBe("14 images missing alt attribute across 9 pages");
    expect(agg.details?.distinctItems).toBe(14);
  });
});

describe("a capped item list", () => {
  test("the distinct count is larger than the list", () => {
    const limits: FoldLimits = { ...LIMITS, maxItemsPerCheck: 3 };
    const checks = Array.from({ length: 5 }, (_, i) => missingAlt(page(i), [`/a/${i}.jpg`, `/b/${i}.jpg`]));
    const agg = fold(checks, limits);
    expect(agg.items).toHaveLength(3);
    expect(agg.details?.distinctItems).toBe(10);
    expect(agg.message).toBe("10 images missing alt attribute across 5 pages");
  });
});

describe("pages that disagree", () => {
  test("core/h1: an empty H1 and several H1s are listed, each with its pages", () => {
    const h1 = (url: string, message: string): CheckResult => ({ name: "h1", status: "warn", message, pageUrl: url });
    const agg = fold([
      h1(page(0), "H1 tag is empty"),
      h1(page(1), "H1 tag is empty"),
      h1(page(2), "Multiple H1 tags found (3)"),
      h1(page(3), "Multiple H1 tags found (5)"),
      h1(page(4), "Multiple H1 tags found (2)"),
    ]);
    expect(agg.message).toBe("Multiple H1 tags found (2 to 5) on 3 pages; H1 tag is empty on 2 pages");
    expect(agg.message).not.toBe("H1 tag is empty (+4 more pages)");
  });

  test("perf/ttfb: slow pages with different timings are not all reported at the first page's timing", () => {
    const ttfb = (i: number, status: "warn" | "fail", message: string): CheckResult => ({
      name: "ttfb",
      status,
      message,
      pageUrl: page(i),
    });
    const slow = foldOverflowChecks(
      [ttfb(0, "warn", "Slow server response (850ms)"), ttfb(1, "warn", "Slow server response (1200ms)"), ttfb(2, "fail", "Very slow server response (4100ms)")],
      { ...LIMITS, maxChecks: 2 },
    );
    const warn = slow.find((c) => c.status === "warn")!;
    expect(warn.message).toBe("Slow server response (850 to 1200ms) on 2 pages");
    // A different status stays its own aggregate and its own sentence.
    const fail = slow.find((c) => c.status === "fail")!;
    expect(fail.message).toBe("Very slow server response (4100ms)");
  });

  test("images: missing alt on some pages and a different count on others become a range", () => {
    const agg = fold([missingAlt(page(0), ["/x.jpg"]), missingAlt(page(1), ["/x.jpg", "/y.jpg", "/z.jpg"])]);
    expect(agg.message).toBe("3 images missing alt attribute across 2 pages");
  });
});

describe("unfolding", () => {
  test("an aggregate expands back to the per-page message, not the composed one", () => {
    const agg = fold(Array.from({ length: 4 }, (_, i) => missingAlt(page(i), ["/img/hero.jpg"])));
    const pages = unfoldAggregateCheck(agg);
    expect(pages.map((c) => c.message)).toEqual(Array(4).fill("1 image(s) missing alt attribute"));
    expect(pages[0]!.details?.distinctItems).toBeUndefined();
    expect(pages[0]!.details?.pageMessage).toBeUndefined();
  });

  test("re-folding aggregates keeps counting pages and does not stack wording", () => {
    const a = fold(Array.from({ length: 3 }, (_, i) => missingAlt(page(i), ["/img/hero.jpg"])));
    const b = fold(Array.from({ length: 2 }, (_, i) => missingAlt(page(10 + i), ["/img/hero.jpg"])));
    const merged = foldOverflowChecks([a, b], LIMITS);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toBe("1 image missing alt attribute, shown on 5 pages");
  });
});
