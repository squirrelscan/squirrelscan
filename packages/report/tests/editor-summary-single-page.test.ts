// The editor-summary request carries `coverage.singlePageSite` and the section
// count only when crawl/single-page-site fired on a crawl that stopped for no
// other reason (pub#1209). Every other request is unchanged.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { buildEditorSummaryRequest } from "../src/editor-summary";

const FIRED = {
  "crawl/single-page-site": {
    meta: { name: "Single-Page Site", category: "crawl", weight: 1 },
    checks: [{ name: "single-page-site", status: "info", details: { sections: 4 } }],
  },
};

function report(extra: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://acme.example",
    timestamp: "2026-10-28T00:00:00.000Z",
    totalPages: 1,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: FIRED,
    scanScope: { origin: "cli", pagesCrawled: 1, capped: false },
    generatorVersion: "1.2.3",
    ...extra,
  } as unknown as AuditReport;
}

describe("coverage.singlePageSite", () => {
  test("is sent with the section count when the finding fired", () => {
    expect(buildEditorSummaryRequest(report()).coverage).toEqual({
      scannedPages: 1,
      capped: false,
      timeStopped: false,
      singlePageSite: true,
      sectionCount: 4,
    });
  });

  test("is omitted when the finding did not fire", () => {
    const req = buildEditorSummaryRequest(report({ ruleResults: {} }));
    expect(req.coverage).toEqual({ scannedPages: 1, capped: false, timeStopped: false });
    expect("singlePageSite" in (req.coverage ?? {})).toBe(false);
    expect("sectionCount" in (req.coverage ?? {})).toBe(false);
  });

  test("is omitted when the crawl was capped, time-stopped or left URLs unfetched", () => {
    for (const scanScope of [
      { origin: "cli", pagesCrawled: 1, maxPages: 1, capped: true },
      { origin: "cli", pagesCrawled: 1, capped: false, stopReason: "time" },
      { origin: "cli", pagesCrawled: 1, capped: false, unfetched: 3 },
    ]) {
      const req = buildEditorSummaryRequest(report({ scanScope } as Partial<AuditReport>));
      expect(req.coverage?.singlePageSite).toBeUndefined();
      expect(req.coverage?.sectionCount).toBeUndefined();
    }
  });

  test("a section count that is not a whole number is not trusted", () => {
    const req = buildEditorSummaryRequest(
      report({
        ruleResults: {
          "crawl/single-page-site": {
            meta: { name: "x", category: "crawl", weight: 1 },
            checks: [{ name: "single-page-site", status: "info", details: { sections: -2 } }],
          },
        } as unknown as AuditReport["ruleResults"],
      }),
    );
    expect(req.coverage?.singlePageSite).toBeUndefined();
  });
});
