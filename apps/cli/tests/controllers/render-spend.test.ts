// Render spend lines surface the ACTUAL server debit per feature, so a render
// cache hit shows as its own render_cached (1cr) line — not lumped under render
// at the 2cr estimate. #279

import type { RenderChargeLine } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import {
  auditedPageCount,
  foldRenderSpendLines,
  withAuditPageSettlement,
} from "../../src/controllers/audit";

describe("foldRenderSpendLines", () => {
  test("no charges → no lines", () => {
    expect(foldRenderSpendLines([])).toEqual([]);
  });

  test("a render cache hit shows render_cached (1cr), matching the ledger", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "render_cached", units: 1, credits: 1 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      {
        service: "render_cached",
        feature: "render_cached",
        units: 1,
        credits: 1,
      },
    ]);
  });

  test("only misses → a single render line at the real debit", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "render", units: 2, credits: 4 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "render", feature: "render", units: 2, credits: 4 },
    ]);
  });

  test("mixed batches fold into separate render + render_cached lines, summed", () => {
    // Two batches: batch 1 = 2 misses + 1 hit, batch 2 = 1 miss + 2 hits.
    const breakdown: RenderChargeLine[] = [
      { feature: "render", units: 2, credits: 4 },
      { feature: "render_cached", units: 1, credits: 1 },
      { feature: "render", units: 1, credits: 2 },
      { feature: "render_cached", units: 2, credits: 2 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "render", feature: "render", units: 3, credits: 6 },
      {
        service: "render_cached",
        feature: "render_cached",
        units: 3,
        credits: 3,
      },
    ]);
  });
});

describe("foldRenderSpendLines under pricing v11 (#2290)", () => {
  test("a run's renders come back as audit_page and fold into one line", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "audit_page", units: 3, credits: 6 },
      { feature: "audit_page", units: 2, credits: 4 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "audit-pages", feature: "audit_page", units: 5, credits: 10 },
    ]);
  });

  test("a standalone render (no run) keeps its own line beside the pages", () => {
    const breakdown: RenderChargeLine[] = [
      { feature: "render", units: 1, credits: 2 },
      { feature: "audit_page", units: 4, credits: 8 },
    ];
    expect(foldRenderSpendLines(breakdown)).toEqual([
      { service: "audit-pages", feature: "audit_page", units: 4, credits: 8 },
      { service: "render", feature: "render", units: 1, credits: 2 },
    ]);
  });
});

describe("withAuditPageSettlement (#2290)", () => {
  const base = {
    service: "audit-base",
    feature: "audit_base",
    units: 1,
    credits: 50,
  };

  test("a 19-page audit that rendered nothing settles all 19 pages: 88 total", () => {
    const lines = withAuditPageSettlement([base], 19);
    expect(lines).toEqual([
      base,
      { service: "audit-pages", feature: "audit_page", units: 19, credits: 38 },
    ]);
    expect(lines.reduce((sum, l) => sum + l.credits, 0)).toBe(88);
  });

  test("pages the renders already paid for are not charged again", () => {
    // 4 rendered in the crawl, 2 in the raw-vs-rendered prefetch, 13 settled.
    const lines = withAuditPageSettlement(
      [
        base,
        { service: "audit-pages", feature: "audit_page", units: 4, credits: 8 },
        { service: "render", feature: "audit_page", units: 2, credits: 4 },
        {
          service: "tech-detect",
          feature: "tech_detect",
          units: 1,
          credits: 0,
        },
      ],
      19
    );
    expect(lines).toEqual([
      base,
      { service: "audit-pages", feature: "audit_page", units: 19, credits: 38 },
      { service: "tech-detect", feature: "tech_detect", units: 1, credits: 0 },
    ]);
  });

  test("renders for urls that never became audited pages are refunded at settlement (#2399)", () => {
    // Run 01M3XT03CZ: 13 rendered, 2 audited (2 were 404s, 9 were 500s).
    const lines = withAuditPageSettlement(
      [
        base,
        {
          service: "audit-pages",
          feature: "audit_page",
          units: 13,
          credits: 26,
        },
      ],
      2
    );
    expect(lines).toEqual([
      base,
      { service: "audit-pages", feature: "audit_page", units: 2, credits: 4 },
    ]);
  });

  test("a zero-page audit with no renders adds nothing", () => {
    expect(withAuditPageSettlement([base], 0)).toEqual([base]);
  });

  test("a zero-page audit refunds every prepaid render", () => {
    expect(
      withAuditPageSettlement(
        [
          base,
          {
            service: "audit-pages",
            feature: "audit_page",
            units: 3,
            credits: 6,
          },
        ],
        0
      )
    ).toEqual([base]);
  });

  test("the page count is the one the report shows as audited (#2399)", () => {
    // "Coverage: audited 2 of 2 known pages", not "Scan: 4 pages crawled".
    expect(
      auditedPageCount({
        pages: [1, 2, 3, 4],
        totalPages: 2,
        coverage: { auditedPages: 2 },
        scanScope: { pagesCrawled: 4 },
      })
    ).toBe(2);
    // A smart-audit union: this run's pages, not every known page.
    expect(
      auditedPageCount({
        pages: Array.from({ length: 12 }, (_, i) => i),
        totalPages: 40,
        coverage: { auditedPages: 12 },
      })
    ).toBe(12);
    // Never more than this run fetched: coverage says 50, the crawl fetched 10.
    expect(
      auditedPageCount({
        pages: [],
        totalPages: 60,
        coverage: { auditedPages: 50 },
        scanScope: { pagesCrawled: 10 },
      })
    ).toBe(10);
    // No coverage: the "N pages" header.
    expect(
      auditedPageCount({
        pages: [1, 2, 3],
        totalPages: 3,
        scanScope: { pagesCrawled: 3 },
      })
    ).toBe(3);
    expect(auditedPageCount({ pages: [1, 2, 3] })).toBe(3);
  });
});
