// #1167 payload-size invariant: a published report is O(rules × sample_cap),
// FLAT regardless of crawl size. The real 500-page repro report was only
// available in the user-facing JSON shape (not the internal AuditReport
// slimForPublish takes), so prove the bound with a synthetic worst-case report
// instead: every rule fails site-wide across a huge page list, with items that
// each fan out to 100 sourcePages.

import {
  PUBLISH_LIMITS,
  REPORT_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { slimForPublish } from "../../src/controllers/report/publish";

const emptySummary = {
  missingTitles: [],
  missingDescriptions: [],
  missingOgTags: [],
  missingTwitterCards: [],
  missingSchemas: [],
  missingAltText: [],
  multipleH1s: [],
  thinContentPages: [],
  urlIssues: [],
  redirectChains: [],
  securityIssues: [],
};

const RULES = 260; // ≈ the shipped catalog size
const url = (i: number) =>
  `https://perspectivesintopractice.com/section-${i % 40}/page-${i}-with-a-longish-slug`;

// One folded aggregate per rule: a site-wide failure across `pageCount` pages,
// each rule carrying maxItems worth of items that each fan out to 100 sourcePages.
function hugeReport(pageCount: number): AuditReport {
  const pages = Array.from({ length: pageCount }, (_, i) => url(i));
  const items = Array.from(
    { length: PUBLISH_LIMITS.maxItems + 20 },
    (_, i) => ({
      id: `item-${i}`,
      label: `Broken resource ${i}`,
      sourcePages: Array.from({ length: 100 }, (_, j) =>
        url((i * 7 + j) % pageCount)
      ),
    })
  );
  const ruleResults: Record<string, unknown> = {};
  for (let r = 0; r < RULES; r++) {
    ruleResults[`rule-${r}`] = {
      meta: {
        id: `rule-${r}`,
        name: `Rule ${r}`,
        description: "",
        category: "seo",
        scope: "site",
        severity: "error",
        weight: 1,
      },
      checks: [
        {
          name: "site-wide-failure",
          status: "fail",
          message: `Rule ${r} failed (+${pageCount - 1} more pages)`,
          pages,
          items,
          details: { aggregated: true, occurrences: pageCount },
        },
      ],
    };
  }
  return {
    baseUrl: "https://perspectivesintopractice.com",
    status: "completed",
    pages: [],
    siteChecks: [],
    summary: emptySummary,
    ruleResults,
  } as unknown as AuditReport;
}

const bodyBytes = (report: AuditReport) =>
  JSON.stringify({ report: slimForPublish(report), visibility: "public" })
    .length;

describe("slimForPublish payload size bound (#1167)", () => {
  test("a 5000-page-per-check report fits well under the 20MB gate", () => {
    const bytes = bodyBytes(hugeReport(5000));
    expect(bytes).toBeLessThan(REPORT_LIMITS.maxPayloadBytes);

    // Analytical worst case: rules × (pages_cap + items_cap × sourcePages_cap)
    // URL entries × ~avg URL bytes. With the caps this is a few MB, orders of
    // magnitude below the pre-#1167 crawl-scaled size — assert it's in that band,
    // not accidentally still crawl-scaled.
    const urlEntries =
      RULES *
      (PUBLISH_LIMITS.maxPagesPerCheckPublish +
        PUBLISH_LIMITS.maxItems * PUBLISH_LIMITS.maxSourcePagesPerItemPublish);
    const analyticalUpperBytes = urlEntries * 120; // generous per-entry byte budget
    expect(bytes).toBeLessThan(analyticalUpperBytes);
  }, 20_000);

  test("payload is FLAT in crawl size — doubling the crawl doesn't scale the body", () => {
    // The only things that grow with crawl size are check.pages[] and item
    // sourcePages, both capped at publish. Doubling the crawl (5000→10000
    // pages/check) leaves ~50MB of extra raw page URLs on the cutting-room floor;
    // the slimmed body must stay essentially constant. It's not byte-IDENTICAL —
    // details.pagesTruncated faithfully records the real per-check total (5000 vs
    // 10000) and sampled sourcePages differ — but the delta is a handful of digits
    // per rule, far below any crawl-proportional growth. That is the O(rules × cap)
    // invariant.
    const b5k = bodyBytes(hugeReport(5000));
    const b10k = bodyBytes(hugeReport(10_000));
    expect(Math.abs(b10k - b5k) / b5k).toBeLessThan(0.001);
    // #1185: the resolution signal is part of the body now — the flat invariant
    // covers it too (its hash budget is fixed, not crawl-scaled). This
    // adversarial shape is CPU-heavy (millions of synthetic URLs), hence the
    // explicit timeout: slowness here is load, not a size regression.
  }, 20_000);
});

// #1185: the resolution signal on the REAL evidence shape — a 505-page site
// (NPJQ4JY0) with heavy failing rules. Measured bytes must be a small fraction
// of the 20MB /v1/reports gate (the same bodyLimit guards /v1/reports/internal).
describe("resolution signal payload size (#1185, 505-page shape)", () => {
  test("measured signal bytes are bounded and small against the 20MB gate", () => {
    const PAGES = 505;
    const pageUrls = Array.from({ length: PAGES }, (_, i) => url(i));
    // Live-evidence shape: ~60 failing rule-check classes averaging ~300
    // affected pages (token-weight 502, sri ~505, critical-request-chains 553
    // occurrences, …) — deliberately pessimistic.
    const ruleResults: Record<string, unknown> = {};
    for (let r = 0; r < 60; r++) {
      const affected = pageUrls.slice(0, 200 + ((r * 61) % 305));
      ruleResults[`rule-${r}`] = {
        meta: {
          id: `rule-${r}`,
          scope: "page",
          severity: "warning",
          weight: 1,
        },
        checks: [
          {
            name: "check",
            status: r % 3 === 0 ? "fail" : "warn",
            message: "issue",
            pages: affected,
            details: { aggregated: true, occurrences: affected.length },
          },
        ],
      };
    }
    const report = {
      baseUrl: "https://perspectivesintopractice.com",
      status: "completed",
      pages: pageUrls.map((u) => ({ url: u, statusCode: 200 })),
      siteChecks: [],
      summary: emptySummary,
      ruleResults,
    } as unknown as AuditReport;

    const slim = slimForPublish(report);
    expect(slim.resolutionSignal).toBeDefined();
    const signalBytes = JSON.stringify(slim.resolutionSignal).length;
    const bodyTotal = JSON.stringify({
      report: slim,
      visibility: "public",
    }).length;

    // ~505 URLs (~30KB) + ~18k hashes (~200KB): assert the measured order of
    // magnitude so a regression back to crawl-scaled full URLs trips this.
    expect(signalBytes).toBeLessThan(400 * 1024);
    expect(signalBytes).toBeGreaterThan(30 * 1024); // sanity: it IS carrying data
    expect(bodyTotal).toBeLessThan(REPORT_LIMITS.maxPayloadBytes);
    // The signal is a minor fraction of the whole publish body budget.
    expect(signalBytes / REPORT_LIMITS.maxPayloadBytes).toBeLessThan(0.02);

    // This shape has no pass records, so every clean page is unevaluated as far
    // as the builder can prove — the worst case for `notEvaluated`. Measured:
    // 366KB total (1.79% of the gate), 10,980 notEvaluated hashes.
    expect(slim.resolutionSignal!.notEvaluated).toBeDefined();
  });

  test("a run with pass records emits NO notEvaluated — the realistic case is free", () => {
    // A real report keeps the passing pages too (per-page pass checks, or a
    // folded pass aggregate listing them), so every crawled page is proven
    // evaluated and the complement is empty. Measured: 247KB, identical to the
    // signal before notEvaluated existed.
    const PAGES = 505;
    const pageUrls = Array.from({ length: PAGES }, (_, i) => url(i));
    const ruleResults: Record<string, unknown> = {};
    for (let r = 0; r < 60; r++) {
      const affected = pageUrls.slice(0, 200 + ((r * 61) % 305));
      const affectedSet = new Set(affected);
      const clean = pageUrls.filter((u) => !affectedSet.has(u));
      ruleResults[`rule-${r}`] = {
        meta: {
          id: `rule-${r}`,
          scope: "page",
          severity: "warning",
          weight: 1,
        },
        checks: [
          {
            name: "check",
            status: "warn",
            message: "issue",
            pages: affected,
            details: { aggregated: true, occurrences: affected.length },
          },
          {
            name: "check",
            status: "pass",
            message: "ok",
            pages: clean,
            details: { aggregated: true, occurrences: clean.length },
          },
        ],
      };
    }
    const report = {
      baseUrl: "https://perspectivesintopractice.com",
      status: "completed",
      pages: pageUrls.map((u) => ({ url: u, statusCode: 200 })),
      siteChecks: [],
      summary: emptySummary,
      ruleResults,
    } as unknown as AuditReport;

    const signal = slimForPublish(report).resolutionSignal!;
    expect(signal.notEvaluated).toBeUndefined();
    expect(JSON.stringify(signal).length).toBeLessThan(400 * 1024);
  });
});
