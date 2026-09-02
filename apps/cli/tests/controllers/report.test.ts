import { renderJson, seedRedirect } from "@squirrelscan/report";
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

  /** Render slim JSON, reload it, and hand back the reconstructed report. */
  function roundTrip(source: AuditReport): AuditReport {
    const dir = mkdtempSync(join(tmpdir(), "squirrel-slim-"));
    const path = join(dir, "report.json");
    try {
      writeFileSync(path, renderJson(source));
      const result = loadReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("loadReport failed");
      return result.data;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("carries a refused off-site seed redirect through reconstruction (#1418)", () => {
    // Without this, `--format json` then re-render is a silent way to turn a
    // report about a redirected seed back into what reads as a clean audit.
    const reloaded = roundTrip(
      createMockReport({ finalUrl: "https://other.example/landing" })
    );
    expect(seedRedirect(reloaded)).toEqual({
      finalUrl: "https://other.example/landing",
      baseUrl: "https://example.com",
      note: "Seed redirected off-site to https://other.example/landing, not followed. This audit graded https://example.com.",
    });
  });

  test("a withheld redirect target survives the round trip as withheld (#1418)", () => {
    // The target was never serialized, so there is nothing to restore — but the
    // disclosure must not be lost either, least of all in the case where the
    // stored value was hostile enough to be refused in the first place.
    const csi = String.fromCharCode(0x9b);
    const override = String.fromCharCode(0x202e);
    const reloaded = roundTrip(
      createMockReport({ finalUrl: `not-a-url${csi}2J${override}txt` })
    );
    const disclosure = seedRedirect(reloaded);
    expect(disclosure?.finalUrl).toBeNull();
    expect(disclosure?.note).toBe(
      "Seed redirected off-site and was not followed. The redirect target was not a valid URL and is withheld. This audit graded https://example.com."
    );
    expect(reloaded.finalUrl).not.toContain("not-a-url");
    expect(reloaded.finalUrl).not.toContain(csi);
    expect(reloaded.finalUrl).not.toContain(override);
  });

  test("a report without a redirect gains no finalUrl from reconstruction", () => {
    expect(roundTrip(createMockReport({})).finalUrl).toBeUndefined();
  });

  test("a forged seedRedirect field discloses rather than crashing a renderer", () => {
    // The JSON is user-supplied, so its declared types are a claim. A
    // finalUrl that is not a string must not reach a renderer as-is.
    const slim = {
      meta: {
        version: "0.0.89",
        baseUrl: "https://example.com",
        seedRedirect: { finalUrl: 42, followed: false, note: "anything" },
        timestamp: new Date().toISOString(),
        totalPages: 1,
      },
      score: { overall: 90, grade: "A", categories: [] },
      summary: { passed: 1, warnings: 0, failed: 0 },
      issues: [],
    };

    const dir = mkdtempSync(join(tmpdir(), "squirrel-slim-"));
    const path = join(dir, "report.json");
    try {
      writeFileSync(path, JSON.stringify(slim));
      const result = loadReport(path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Disclosed, withheld, and the forged note is not echoed back.
        expect(seedRedirect(result.data)?.finalUrl).toBeNull();
        expect(seedRedirect(result.data)?.note).not.toContain("anything");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
