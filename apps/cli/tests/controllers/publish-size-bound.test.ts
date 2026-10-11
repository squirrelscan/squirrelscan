// #1167 payload-size invariant: a published report is O(rules × sample_cap),
// FLAT regardless of crawl size. The real 500-page repro report was only
// available in the user-facing JSON shape (not the internal AuditReport
// slimForPublish takes), so prove the bound with a synthetic worst-case report
// instead: every rule fails site-wide across a huge page list, with items that
// each fan out to 100 sourcePages.

import {
  PUBLISH_LIMITS,
  REPORT_LIMITS,
  RESOLUTION_PUBLISH_LIMITS,
} from "@squirrelscan/core-contracts/limits";
import { decodeResolutionSignal } from "@squirrelscan/core-contracts/resolution";
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
    //
    // #2658: the resolution signal is held to its own fixed byte budget instead
    // (it is deflated, so its size follows the URL text, not a count), and the
    // rest of the body stays flat. This adversarial shape is CPU-heavy (millions
    // of synthetic URLs), hence the explicit timeout: slowness here is load, not
    // a size regression.
    const parts = (pageCount: number) => {
      const slim = slimForPublish(hugeReport(pageCount));
      const signal = JSON.stringify(slim.resolutionSignalCompact).length;
      const rest = JSON.stringify({
        report: { ...slim, resolutionSignalCompact: undefined },
        visibility: "public",
      }).length;
      return { signal, rest };
    };
    const p5k = parts(5000);
    const p10k = parts(10_000);
    expect(Math.abs(p10k.rest - p5k.rest) / p5k.rest).toBeLessThan(0.001);
    expect(p5k.signal).toBeLessThanOrEqual(RESOLUTION_PUBLISH_LIMITS.maxBytes);
    expect(p10k.signal).toBeLessThanOrEqual(RESOLUTION_PUBLISH_LIMITS.maxBytes);
  }, 30_000);
});

// #1185: the resolution signal on the REAL evidence shape — a 505-page site
// (NPJQ4JY0) with heavy failing rules. #2658: it ships compact now, inside the
// fixed RESOLUTION_PUBLISH_LIMITS budget, carrying the same evidence.
describe("resolution signal payload size (#1185, 505-page shape)", () => {
  test("measured signal bytes are bounded and small against the 20MB gate", async () => {
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
    expect(slim.resolutionSignalCompact).toBeDefined();
    const signalBytes = JSON.stringify(slim.resolutionSignalCompact).length;
    const bodyTotal = JSON.stringify({
      report: slim,
      visibility: "public",
    }).length;

    // The original shape measured 366KB here (505 URLs + ~18k failing and
    // ~11k not-evaluated hashes). Compact, the same evidence is a few KB.
    expect(signalBytes).toBeLessThanOrEqual(RESOLUTION_PUBLISH_LIMITS.maxBytes);
    expect(signalBytes).toBeLessThan(20 * 1024);
    expect(bodyTotal).toBeLessThan(REPORT_LIMITS.maxPayloadBytes);

    // This shape has no pass records, so every clean page is unevaluated as far
    // as the builder can prove — the worst case for `notEvaluated` — and none of
    // it was dropped to fit.
    const signal = await decodeResolutionSignal(slim.resolutionSignalCompact!);
    expect(signal.crawledUrls).toHaveLength(PAGES);
    expect(signal.notEvaluated).toBeDefined();
    expect(signal.truncated).toBeUndefined();
  });

  test("a run with pass records emits NO notEvaluated — the realistic case is free", async () => {
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

    const compact = slimForPublish(report).resolutionSignalCompact!;
    const signal = await decodeResolutionSignal(compact);
    expect(signal.notEvaluated).toBeUndefined();
    expect(JSON.stringify(compact).length).toBeLessThan(20 * 1024);
  });
});
