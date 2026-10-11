// slimForPublish is the engine's report capper (repo#2667) plus what only the
// CLI knows. The capper's own contract (per-class samples with true counts,
// tallies, the byte fitter) is pinned in audit-engine's publish-cap tests; these
// pin what the CLI's publish body adds and keeps on top of it.

import { REPORT_CAPS } from "@squirrelscan/core-contracts/limits";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { version } from "../../package.json";
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

const meta = {
  id: "images/alt-text",
  name: "alt text",
  description: "Images need alt text.",
  category: "images",
  scope: "page",
  severity: "error",
  weight: 6,
};

function makeReport(checks: unknown[]): AuditReport {
  return {
    baseUrl: "https://example.com",
    pages: [],
    siteChecks: [],
    summary: emptySummary,
    ruleResults: { "images/alt-text": { meta, checks } },
  } as unknown as AuditReport;
}

const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => `https://example.com/page-${i}`);

describe("slimForPublish (repo#2667)", () => {
  test("is a capped summary that says the full detail is local", () => {
    const slim = slimForPublish(
      makeReport([
        {
          name: "site-wide",
          status: "fail",
          message: "Missing",
          pages: pages(500),
        },
      ])
    );
    expect(slim.detail).toMatchObject({
      capped: true,
      tier: 0,
      fullDetail: "local",
    });
    expect(slim.pages).toEqual([]);
    // One class, sampled, with its true count.
    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
      details?: { pagesTruncated?: number };
    };
    expect(check.pages).toHaveLength(REPORT_CAPS.tiers[0]!.pagesPerClass);
    expect(check.details?.pagesTruncated).toBe(500);
    // The server rescores from the tallies, not from the dropped rows.
    expect(slim.checkTallies["images/alt-text"]).toBeDefined();
  });

  test("carries the CLI's version and the cloud rules it did not run", () => {
    const slim = slimForPublish(makeReport([]));
    expect(slim.generatorVersion).toBe(version);
    expect(Array.isArray(slim.lockedRules)).toBe(true);
  });

  test("drops the local replay cache", () => {
    const report = makeReport([]);
    (report as { rulesCache?: unknown }).rulesCache = {
      pagesReplayed: 3,
      pagesEvaluated: 7,
    };
    expect("rulesCache" in slimForPublish(report)).toBe(false);
  });

  test("does not mutate the input report", () => {
    const report = makeReport([
      {
        name: "site-wide",
        status: "fail",
        message: "Missing",
        pages: pages(500),
      },
    ]);
    const before = structuredClone(report);
    slimForPublish(report);
    expect(report).toEqual(before);
  });

  test("preserves scanScope on the payload (#1180)", () => {
    const report = makeReport([]);
    report.scanScope = {
      origin: "cli",
      maxPages: 100,
      pagesCrawled: 100,
      capped: true,
    };
    expect(slimForPublish(report).scanScope).toEqual({
      origin: "cli",
      maxPages: 100,
      pagesCrawled: 100,
      capped: true,
    });
  });
});

// #1185: the resolution signal is built from the FULL report (every crawled
// page, every failing page), however hard the checks themselves are sampled.
describe("slimForPublish resolution signal (#1185)", () => {
  const pageStub = (url: string) => ({ url, statusCode: 200 }) as never;

  test("carries UNSAMPLED failing sets and the full crawled list, compact", async () => {
    const report = makeReport([
      {
        name: "alt-text-missing",
        status: "fail",
        message: "Missing alt text",
        pages: pages(500),
        details: { aggregated: true, occurrences: 500 },
      },
    ]);
    report.pages = pages(500).map(pageStub);

    const slim = slimForPublish(report);

    const check = slim.ruleResults["images/alt-text"]!.checks[0]! as {
      pages: string[];
    };
    expect(check.pages.length).toBeLessThan(500);
    expect("resolutionSignal" in slim).toBe(false);
    const signal = await decodeResolutionSignal(slim.resolutionSignalCompact!);
    expect(signal.crawledUrls).toHaveLength(500);
    expect(signal.failing["images/alt-text|alt-text-missing"]).toHaveLength(
      500
    );
    expect(signal.truncated).toBeUndefined();
  });

  test("no signal for a report with no crawled pages", () => {
    const slim = slimForPublish(makeReport([]));
    expect(slim.resolutionSignalCompact).toBeUndefined();
    expect(slim.pageStatuses).toBeUndefined();
  });

  test("signal and pageStatuses share one byte share (#2658)", () => {
    // 3,000 pages, a third of them redirects or 404s, every page failing a check.
    const report = makeReport([
      {
        name: "alt-text-missing",
        status: "fail",
        message: "Missing alt text",
        pages: pages(3_000),
        details: { aggregated: true, occurrences: 3_000 },
      },
    ]);
    report.pages = pages(3_000).map(
      (url, i) =>
        ({ url, statusCode: i % 3 ? 200 : i % 2 ? 404 : 301 }) as never
    );
    const slim = slimForPublish(report);
    const used =
      JSON.stringify(slim.resolutionSignalCompact).length +
      JSON.stringify(slim.pageStatuses).length;
    expect(used).toBeLessThanOrEqual(REPORT_CAPS.signalMaxBytes);
    expect(slim.pageStatuses!.length).toBeGreaterThan(0);
    expect(JSON.stringify(slim.pageStatuses).length).toBeLessThanOrEqual(
      REPORT_CAPS.pageStatusesMaxBytes
    );
  });
});
