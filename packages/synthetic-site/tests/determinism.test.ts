// generateSiteModel's core contract: same seed → bit-for-bit identical model.
// No Date.now()/Math.random() anywhere in the generator — this is the guard.

import { describe, expect, test } from "bun:test";

import { generateSiteModel } from "../src/page-model";
import { renderPageHtml } from "../src/html-render";

describe("generateSiteModel determinism", () => {
  test("same seed produces a byte-identical model", () => {
    const opts = { seed: "determinism-seed", pageCount: 250 } as const;
    const a = generateSiteModel(opts);
    const b = generateSiteModel(opts);
    expect(a).toEqual(b);
  });

  test("same numeric seed produces a byte-identical model", () => {
    const opts = { seed: 42, pageCount: 120 } as const;
    const a = generateSiteModel(opts);
    const b = generateSiteModel(opts);
    expect(a).toEqual(b);
  });

  test("different seeds produce different models", () => {
    const a = generateSiteModel({ seed: "seed-one", pageCount: 120 });
    const b = generateSiteModel({ seed: "seed-two", pageCount: 120 });
    expect(a).not.toEqual(b);
  });

  test("rendered HTML for a page is identical across repeated calls (order-independent)", () => {
    const model = generateSiteModel({ seed: "render-determinism", pageCount: 40 });
    const page = model.pages[10]!;
    const first = renderPageHtml(page, "http://example.test");
    const second = renderPageHtml(page, "http://example.test");
    expect(first).toBe(second);
  });

  test("rendered HTML is identical regardless of which page is rendered first (no shared rng state)", () => {
    const model = generateSiteModel({ seed: "render-order-independence", pageCount: 40 });
    const [pageA, pageB] = [model.pages[5]!, model.pages[20]!];

    const forwardA = renderPageHtml(pageA, "http://example.test");
    const forwardB = renderPageHtml(pageB, "http://example.test");

    const reverseB = renderPageHtml(pageB, "http://example.test");
    const reverseA = renderPageHtml(pageA, "http://example.test");

    expect(forwardA).toBe(reverseA);
    expect(forwardB).toBe(reverseB);
  });

  test("model generation for 1k/5k pages stays deterministic (spot-checks the scale targets)", () => {
    for (const pageCount of [1000, 5000]) {
      const opts = { seed: `scale-${pageCount}`, pageCount } as const;
      const a = generateSiteModel(opts);
      const b = generateSiteModel(opts);
      expect(a.pages.length).toBe(b.pages.length);
      expect(a.issueSummary).toEqual(b.issueSummary);
      expect(a).toEqual(b);
    }
  });

  test("25k-page generation stays fast — regression guard for the wireDefaultLinks O(n^2)", () => {
    // Was O(n^2) (re-filtering the full linkable pool per page); at 25k that's
    // ~625M comparisons, multiple seconds. The fix buckets by template once
    // (O(n)) and picks siblings in O(count) via pickFewExcluding. A generous
    // bound (well above the ~50ms observed locally) avoids CI flakiness while
    // still catching a regression back to quadratic behavior.
    const start = performance.now();
    const model = generateSiteModel({ seed: "perf-25k", pageCount: 25_000 });
    const elapsedMs = performance.now() - start;
    expect(model.pages.length).toBeGreaterThanOrEqual(25_000);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
