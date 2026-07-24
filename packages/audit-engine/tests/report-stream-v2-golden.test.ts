// v2 report-assembly golden gate (#1021, PR-F). buildV2Report (bounded: score +
// totals from folded tallies, summary streamed + capped, pages: []) must produce
// a report BYTE-IDENTICAL to v1's generateReportFromStorage on the SAME streaming
// run — every field except `pages` (deliberately [] in v2) and `timestamp` (wall
// clock). Both reports are built from the IDENTICAL runStreamingRules result, so
// the only variable is the assembly path (v1 resident tail vs v2 bounded tail).
//
// This is the report-half twin of streaming-scoring-golden.test.ts (which proves
// calculateHealthScoreFromTallies ≡ calculateHealthScore in isolation); here the
// equivalence is proven end-to-end through the whole report object.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import {
  generateReportFromStorage,
  runStreamingRules,
  type FullAuditReport,
  type PreFetchedAssets,
} from "@squirrelscan/audit-engine";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildV2Report } from "../src/report-stream";
import { buildGoldenBaselineModel, getGoldenBaselineConfig, run } from "./helpers/golden-baseline";

const tmpDir = mkdtempSync(join(tmpdir(), "squirrelscan-report-v2-golden-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Offline assets — no network sizing, matching the golden-baseline harness. */
function emptyAssets(): PreFetchedAssets {
  return {
    resourceSizes: { css: [], images: [] },
    scripts: [],
    pdfSizes: [],
    sitemapUrlStatuses: [],
  };
}

/**
 * A report with the two fields v2 is ALLOWED to differ on removed: `pages`
 * (v2 drops the O(pages) array → []) and `timestamp` (wall clock). `fetchFallbacks`
 * is also stripped — it is a per-page-derived note v2 omits; the fixture is asserted
 * to have none, so stripping it never hides a real divergence here.
 */
function comparableCore(report: FullAuditReport): Omit<FullAuditReport, "pages" | "timestamp"> {
  const { pages: _pages, timestamp: _timestamp, fetchFallbacks: _ff, ...rest } = report;
  return rest;
}

describe("v2 report assembly — byte-identical to v1 except pages[] (#1021 PR-F)", () => {
  test(
    "buildV2Report ≡ generateReportFromStorage over the canonical fixture, sans pages",
    async () => {
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "v2-report.sqlite");
      const { storage: writeStorage } = await writeCrawlToStorage(model, dbPath);
      await run(writeStorage.close());

      const storage = new SQLiteStorage(dbPath);
      try {
        await run(storage.init());
        const crawls = await run(storage.listCrawls(1));
        const crawlId = crawls[0]?.id;
        if (!crawlId) throw new Error("no crawl found in fixture DB");

        const config = getGoldenBaselineConfig();
        // ONE streaming run feeds BOTH report paths — the only variable is the tail.
        const streamResult = await run(runStreamingRules(storage, crawlId, config, emptyAssets()));

        const v1Report = await run(generateReportFromStorage(storage, crawlId, streamResult));
        const v2Report = await run(buildV2Report(storage, crawlId, streamResult));

        // Premise: the fixture has no render-block fallbacks, so v2 omitting the
        // per-page-derived fetchFallbacks note is a non-divergence for this gate.
        expect(v1Report.fetchFallbacks).toBeUndefined();
        expect(v2Report.fetchFallbacks).toBeUndefined();

        // The bounded-tail contract: v2 drops pages, v1 keeps them.
        expect(v2Report.pages).toEqual([]);
        expect(v1Report.pages.length).toBeGreaterThan(0);

        // Everything else — healthScore, summary, passed/warnings/failed totals,
        // siteChecks, robotsTxt, sitemaps, resourceSizes, sitemapUrlStatuses,
        // ruleResults, baseUrl, totalPages, status — must be identical.
        expect(comparableCore(v2Report)).toEqual(comparableCore(v1Report));

        // Explicit spot-checks so a regression names the culprit, not just "objects differ".
        expect(v2Report.healthScore).toEqual(v1Report.healthScore);
        expect(v2Report.summary).toEqual(v1Report.summary);
        expect([v2Report.passed, v2Report.warnings, v2Report.failed]).toEqual([
          v1Report.passed,
          v1Report.warnings,
          v1Report.failed,
        ]);
        expect(v2Report.totalPages).toBe(v1Report.totalPages);
        expect(v2Report.ruleResults).toEqual(v1Report.ruleResults);

        console.log(
          `[report-v2-golden] pages(v1)=${v1Report.pages.length} pages(v2)=${v2Report.pages.length} ` +
            `healthScore=${v2Report.healthScore.overall} passed=${v2Report.passed} ` +
            `warnings=${v2Report.warnings} failed=${v2Report.failed} ` +
            `summaryDupTitles=${v2Report.summary.missingTitles.length}`,
        );
      } finally {
        await run(storage.close());
      }
    },
    60_000,
  );

  test(
    "v2 summary caps each array at REPORT_LIMITS.maxSummaryItems",
    async () => {
      // Same fixture; assert the cap is an upper bound v2 never exceeds (the
      // fixture sits under it, which is exactly why the parity test above holds).
      const model = buildGoldenBaselineModel();
      const dbPath = join(tmpDir, "v2-cap.sqlite");
      const { storage: writeStorage } = await writeCrawlToStorage(model, dbPath);
      await run(writeStorage.close());

      const storage = new SQLiteStorage(dbPath);
      try {
        await run(storage.init());
        const crawlId = (await run(storage.listCrawls(1)))[0]?.id;
        if (!crawlId) throw new Error("no crawl found in fixture DB");

        const streamResult = await run(
          runStreamingRules(storage, crawlId, getGoldenBaselineConfig(), emptyAssets()),
        );
        const report = await run(buildV2Report(storage, crawlId, streamResult));

        const { maxSummaryItems } = (await import("@squirrelscan/core-contracts/limits"))
          .REPORT_LIMITS;
        for (const arr of [
          report.summary.missingTitles,
          report.summary.missingDescriptions,
          report.summary.missingOgTags,
          report.summary.missingTwitterCards,
          report.summary.missingSchemas,
          report.summary.missingAltText,
          report.summary.multipleH1s,
          report.summary.thinContentPages,
        ]) {
          expect(arr.length).toBeLessThanOrEqual(maxSummaryItems);
        }
      } finally {
        await run(storage.close());
      }
    },
    60_000,
  );

  test("v2 heartbeat hook fires once per page batch", async () => {
    const model = buildGoldenBaselineModel();
    const dbPath = join(tmpDir, "v2-heartbeat.sqlite");
    const { storage: writeStorage } = await writeCrawlToStorage(model, dbPath);
    await run(writeStorage.close());

    const storage = new SQLiteStorage(dbPath);
    try {
      await run(storage.init());
      const crawlId = (await run(storage.listCrawls(1)))[0]?.id;
      if (!crawlId) throw new Error("no crawl found in fixture DB");

      const streamResult = await run(
        runStreamingRules(storage, crawlId, getGoldenBaselineConfig(), emptyAssets()),
      );

      const batches: number[] = [];
      const report = await run(
        buildV2Report(storage, crawlId, streamResult, {
          batchSize: 100,
          onBatch: ({ pagesDone }) => batches.push(pagesDone),
        }),
      );

      // pagesDone is monotonically increasing and ends at the full crawl size.
      expect(batches.length).toBeGreaterThan(1);
      expect(batches).toEqual([...batches].sort((a, b) => a - b));
      expect(batches[batches.length - 1]).toBe(report.totalPages);
    } finally {
      await run(storage.close());
    }
  }, 60_000);
});
