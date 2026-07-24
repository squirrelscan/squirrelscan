// slimForPublish item-cap accounting (#910 review finding): the publish-side
// re-slice to PUBLISH_LIMITS.maxItems happens AFTER foldOverflowChecks caps and
// accounts items — the second-pass drop must also land in details.additional or
// the "detail cut" signal under-reports on exactly the large-crawl case.

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

function makeReport(checks: unknown[]): AuditReport {
  return {
    baseUrl: "https://example.com",
    pages: [],
    siteChecks: [],
    summary: emptySummary,
    ruleResults: {
      "images/alt-text": { meta: { id: "images/alt-text" }, checks },
    },
  } as unknown as AuditReport;
}

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    label: `Item ${i}`,
  }));

describe("slimForPublish item-cap accounting", () => {
  test("items dropped by the publish re-slice land in details.additional", () => {
    const slim = slimForPublish(
      makeReport([
        { name: "alt-text-missing", status: "fail", items: items(60) },
      ])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      items: unknown[];
      details?: { additional?: number };
    };
    expect(check.items).toHaveLength(50); // PUBLISH_LIMITS.maxItems
    expect(check.details?.additional).toBe(10);
  });

  test("accumulates on top of an existing fold-side additional count", () => {
    const slim = slimForPublish(
      makeReport([
        {
          name: "alt-text-missing",
          status: "fail",
          items: items(60),
          details: { additional: 5, occurrences: 65 },
        },
      ])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      details?: { additional?: number; occurrences?: number };
    };
    expect(check.details?.additional).toBe(15);
    expect(check.details?.occurrences).toBe(65); // untouched
  });

  test("under-cap checks keep details untouched (no phantom additional)", () => {
    const slim = slimForPublish(
      makeReport([
        { name: "alt-text-missing", status: "fail", items: items(3) },
      ])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      items: unknown[];
      details?: { additional?: number };
    };
    expect(check.items).toHaveLength(3);
    expect(check.details).toBeUndefined();
  });
});

// #1167: publish-time per-check page sampling — a site-wide failing rule ships a
// bounded SAMPLE of affected-page URLs + the true count (details.pagesTruncated),
// never every URL, so the payload is O(rules × sample_cap) regardless of crawl size.
describe("slimForPublish page sampling (#1167)", () => {
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://example.com/page-${i}`);

  test("pages[] over the cap is sampled to 100 + stamps the true count", () => {
    const slim = slimForPublish(
      makeReport([{ name: "site-wide", status: "fail", pages: pages(500) }])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
      details?: { pagesTruncated?: number };
    };
    expect(check.pages).toHaveLength(100); // maxPagesPerCheckPublish
    expect(check.details?.pagesTruncated).toBe(500);
  });

  test("under-cap pages[] is untouched (no pagesTruncated marker)", () => {
    const slim = slimForPublish(
      makeReport([{ name: "site-wide", status: "fail", pages: pages(40) }])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
      details?: { pagesTruncated?: number };
    };
    expect(check.pages).toHaveLength(40);
    expect(check.details?.pagesTruncated).toBeUndefined();
  });

  test("each item's sourcePages is capped to the publish sample (10)", () => {
    const slim = slimForPublish(
      makeReport([
        {
          name: "site-wide",
          status: "fail",
          items: [
            {
              id: "item-0",
              label: "x",
              sourcePages: pages(80),
            },
          ],
        },
      ])
    );
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      items: Array<{ sourcePages?: string[] }>;
    };
    expect(check.items[0]!.sourcePages).toHaveLength(10); // maxSourcePagesPerItemPublish
  });

  test("does not mutate the input report (degrade re-slim needs a pristine original)", () => {
    const report = makeReport([
      { name: "site-wide", status: "fail", pages: pages(500) },
    ]);
    const originalCheck = report.ruleResults["images/alt-text"]!.checks[0] as {
      pages: string[];
      details?: unknown;
    };
    slimForPublish(report);
    // The source check object is untouched — sampling produces a fresh check, and
    // the byte-budget backstop clones rather than mutating in place.
    expect(originalCheck.pages).toHaveLength(500);
    expect(originalCheck.details).toBeUndefined();
  });

  test("idempotent: re-slimming an already-sampled report is stable", () => {
    const once = slimForPublish(
      makeReport([{ name: "site-wide", status: "fail", pages: pages(500) }])
    );
    // Feed the sampled output back through — the pages already fit the cap, so the
    // count + marker stay put (no double-truncation, no marker drift).
    const twice = slimForPublish({
      ...(once as unknown as AuditReport),
      pages: [],
    } as AuditReport);
    const check = twice.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
      details?: { pagesTruncated?: number };
    };
    expect(check.pages).toHaveLength(100);
    expect(check.details?.pagesTruncated).toBe(500);
  });
});

describe("scanScope publish carry (#1180)", () => {
  test("slimForPublish preserves scanScope on the payload", () => {
    const report = makeReport([]);
    report.scanScope = {
      origin: "cli",
      maxPages: 100,
      pagesCrawled: 100,
      capped: true,
    };
    const slim = slimForPublish(report);
    expect(slim.scanScope).toEqual({
      origin: "cli",
      maxPages: 100,
      pagesCrawled: 100,
      capped: true,
    });
  });
});

// #1185: the unsampled resolution signal must be built from the PRE-sample
// report (full pages[] + full check page lists) and attached to the slimmed
// payload — sampling below must not be able to starve it.
describe("slimForPublish resolution signal (#1185)", () => {
  const pageStub = (url: string) => ({ url, statusCode: 200 }) as never;
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://example.com/page-${i}`);

  test("attaches the signal with UNSAMPLED failing sets + the full crawled list", () => {
    const report = makeReport([
      {
        name: "alt-text-missing",
        status: "fail",
        pages: pages(500),
        details: { aggregated: true, occurrences: 500 },
      },
    ]);
    report.pages = pages(500).map(pageStub);

    const slim = slimForPublish(report);

    // The published check was sampled to 100 pages…
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
    };
    expect(check.pages).toHaveLength(100);
    // …but the signal kept every failing page and every crawled URL.
    expect(slim.resolutionSignal).toBeDefined();
    expect(slim.resolutionSignal!.crawledUrls).toHaveLength(500);
    expect(
      slim.resolutionSignal!.failing["images/alt-text|alt-text-missing"]
    ).toHaveLength(500);
    expect(slim.resolutionSignal!.truncated).toBeUndefined();
  });

  test("no signal for an empty report (adds zero payload)", () => {
    const slim = slimForPublish(makeReport([]));
    expect(slim.resolutionSignal).toBeUndefined();
  });
});
