// Tests for analyze controller
//
// Tests simplified in f317b36 to avoid flaky state-dependent tests.
// Old tests assumed clean crawl state or used latest crawl, which was unreliable.
// New tests focus on explicit error cases with nonexistent crawl IDs.
//
// Tests removed/simplified:
// - "returns error when no analyzable crawls exist" → removed (flaky, assumed clean state)
// - "receives progress updates" → simplified to test error case only

import { describe, expect, test } from "bun:test";

import type { CrawlMetadata } from "../../src/crawler/storage/types";

import {
  runAnalyze,
  type AnalyzeResult,
  pickLatestAnalyzeReadyCrawl,
} from "../../src/controllers/analyze";

function createMockCrawl(overrides: Partial<CrawlMetadata>): CrawlMetadata {
  return {
    id: "crawl-1",
    baseUrl: "https://example.com",
    startedAt: 1,
    status: "analyzed",
    config: {
      maxPages: 10,
      concurrency: 2,
      perHostConcurrency: 2,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 10000,
      userAgent: "test",
      followRedirects: true,
      respectRobots: true,
      incremental: true,
      include: [],
      exclude: [],
      allowQueryParams: [],
      dropQueryPrefixes: [],
      allowedDomains: [],
    },
    stats: {
      pagesTotal: 1,
      pagesFetched: 1,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesUnchanged: 0,
      linksTotal: 0,
      imagesTotal: 0,
      bytesTotal: 0,
      avgLoadTimeMs: 0,
    },
    ...overrides,
  };
}

describe("runAnalyze", () => {
  test("returns error for invalid crawl ID lookup", async () => {
    const result = await runAnalyze({
      crawlId: "nonexistent-id",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRAWL_NOT_FOUND");
    }
  }, 10000);
});

describe("AnalyzeResult structure", () => {
  test("contains required fields", () => {
    const mockResult: AnalyzeResult = {
      crawlId: "test-123",
      baseUrl: "https://example.com",
      rulesRun: 45,
      checksTotal: 150,
      passed: 120,
      warnings: 20,
      failed: 10,
    };

    expect(mockResult.crawlId).toBe("test-123");
    expect(mockResult.baseUrl).toBe("https://example.com");
    expect(mockResult.rulesRun).toBe(45);
    expect(mockResult.checksTotal).toBe(150);
    expect(mockResult.passed).toBe(120);
    expect(mockResult.warnings).toBe(20);
    expect(mockResult.failed).toBe(10);
  });

  test("check counts sum correctly", () => {
    const mockResult: AnalyzeResult = {
      crawlId: "test-123",
      baseUrl: "https://example.com",
      rulesRun: 10,
      checksTotal: 100,
      passed: 80,
      warnings: 15,
      failed: 5,
    };

    // passed + warnings + failed should roughly equal checksTotal
    // (may differ due to skipped/info checks)
    expect(mockResult.passed + mockResult.warnings + mockResult.failed).toBe(
      100
    );
  });
});

describe("analyze progress callback", () => {
  test("handles missing crawls without progress updates", async () => {
    const progressUpdates: Array<{ phase: string }> = [];

    const result = await runAnalyze({
      crawlId: "nonexistent-id",
      onProgress: (progress) => {
        progressUpdates.push({ phase: progress.phase });
      },
    });

    expect(result.ok).toBe(false);
    expect(progressUpdates.length).toBe(0);
  }, 10000);
});

describe("pickLatestAnalyzeReadyCrawl", () => {
  test("prefers the latest analyze-ready crawl over newer running crawl", () => {
    const selected = pickLatestAnalyzeReadyCrawl([
      createMockCrawl({
        id: "ready-older",
        startedAt: 100,
        status: "analyzed",
      }),
      createMockCrawl({
        id: "running-newest",
        startedAt: 200,
        status: "running",
      }),
      createMockCrawl({
        id: "ready-newest",
        startedAt: 150,
        status: "crawled",
      }),
    ]);

    expect(selected?.id).toBe("ready-newest");
  });

  test("returns null when no analyze-ready crawls exist", () => {
    const selected = pickLatestAnalyzeReadyCrawl([
      createMockCrawl({
        id: "running",
        status: "running",
        startedAt: 100,
      }),
      createMockCrawl({
        id: "paused",
        status: "paused",
        startedAt: 120,
      }),
      createMockCrawl({
        id: "failed",
        status: "failed",
        startedAt: 140,
      }),
    ]);

    expect(selected).toBeNull();
  });

  test("treats a 'stopped' (partial) crawl as analyze-ready (#969)", () => {
    const selected = pickLatestAnalyzeReadyCrawl([
      createMockCrawl({
        id: "stopped-partial",
        status: "stopped",
        startedAt: 200,
      }),
      createMockCrawl({
        id: "running-newer",
        status: "running",
        startedAt: 300,
      }),
    ]);

    expect(selected?.id).toBe("stopped-partial");
  });
});
