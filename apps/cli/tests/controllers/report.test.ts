import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditReport } from "../../src/types";

import {
  getReportNotReadyReason,
  isReportReadyStatus,
  loadReport,
  validateReportData,
} from "../../src/controllers/report";

function createMockReport(overrides: Partial<AuditReport>): AuditReport {
  return {
    crawlId: "crawl-1",
    baseUrl: "https://example.com",
    timestamp: new Date().toISOString(),
    totalPages: 10,
    passed: 10,
    warnings: 0,
    failed: 0,
    siteChecks: [],
    pages: [],
    summary: {
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
    },
    ruleResults: {},
    ...overrides,
  };
}

describe("isReportReadyStatus", () => {
  test("accepts analyzed and completed statuses", () => {
    expect(isReportReadyStatus("analyzed")).toBe(true);
    expect(isReportReadyStatus("completed")).toBe(true);
  });

  test("rejects non-report statuses", () => {
    expect(isReportReadyStatus("running")).toBe(false);
    expect(isReportReadyStatus("paused")).toBe(false);
    expect(isReportReadyStatus("crawled")).toBe(false);
    expect(isReportReadyStatus("failed")).toBe(false);
    // A stopped (partial, unanalyzed) crawl is not report-ready, like "crawled".
    expect(isReportReadyStatus("stopped")).toBe(false);
  });
});

describe("getReportNotReadyReason", () => {
  test("maps known statuses to clear reasons", () => {
    expect(getReportNotReadyReason("running")).toBe("still in progress");
    expect(getReportNotReadyReason("paused")).toBe("paused");
    expect(getReportNotReadyReason("failed")).toBe("failed");
    expect(getReportNotReadyReason("crawled")).toBe("crawled but not analyzed");
    expect(getReportNotReadyReason("stopped")).toBe(
      "stopped before finishing, not yet analyzed"
    );
  });
});

describe("validateReportData", () => {
  test("fails when total pages is zero", () => {
    const result = validateReportData(createMockReport({ totalPages: 0 }), "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRAWL_NOT_READY");
    }
  });

  test("fails when no analyzed checks exist", () => {
    const result = validateReportData(
      createMockReport({
        totalPages: 5,
        passed: 0,
        warnings: 0,
        failed: 0,
      }),
      "x"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRAWL_NOT_READY");
    }
  });

  test("passes when report has pages and analyzed checks", () => {
    const report = createMockReport({
      totalPages: 5,
      passed: 2,
      warnings: 1,
      failed: 1,
    });
    const result = validateReportData(report, "x");
    expect(result.ok).toBe(true);
  });
});

describe("loadReport - slim JSON reconstruction", () => {
  test("reconstructs stable adblock/* rule IDs under the blocking category", () => {
    // Slim JSON keeps stable rule IDs (adblock/*) while the category was
    // renamed to "blocking"; reconstruction must normalize the legacy prefix
    // and carry the emitted subcategory through.
    const slim = {
      meta: {
        version: "0.0.44",
        baseUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        totalPages: 3,
      },
      score: { overall: 80, grade: "B", categories: [] },
      summary: { passed: 5, warnings: 1, failed: 0 },
      issues: [
        {
          ruleId: "adblock/blocked-links",
          name: "Blocked Tracking Links",
          description: "Links ad blockers would block",
          category: "Blocking",
          subcategory: "ad",
          severity: "warning",
          checks: [
            {
              name: "blocked-links",
              status: "warn",
              message: "1 resource would be blocked",
              affectedPages: ["https://example.com/"],
            },
          ],
        },
      ],
    };

    const dir = mkdtempSync(join(tmpdir(), "squirrel-slim-"));
    const path = join(dir, "report.json");
    try {
      writeFileSync(path, JSON.stringify(slim));
      const result = loadReport(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.data.ruleResults["adblock/blocked-links"]?.meta;
        expect(meta?.category).toBe("blocking");
        expect(meta?.subcategory).toBe("ad");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("carries status/statusReason through reconstruction (#801)", () => {
    // A blocked slim JSON re-rendered via the CLI must keep the failure
    // signal, not read as a clean 0-issue pass.
    const slim = {
      meta: {
        version: "0.0.67",
        baseUrl: "https://example.com",
        timestamp: new Date().toISOString(),
        totalPages: 0,
      },
      status: "blocked",
      statusReason:
        "Site blocked the crawler (bot protection / auth / rate limit)",
      score: { overall: null, grade: "N/A", categories: [] },
      summary: { passed: 0, warnings: 0, failed: 0 },
      issues: [],
    };

    const dir = mkdtempSync(join(tmpdir(), "squirrel-slim-"));
    const path = join(dir, "report.json");
    try {
      writeFileSync(path, JSON.stringify(slim));
      const result = loadReport(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe("blocked");
        expect(result.data.statusReason).toBe(
          "Site blocked the crawler (bot protection / auth / rate limit)"
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
