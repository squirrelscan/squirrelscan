// The report's `baseUrl` is the site the user asked for, always. When the
// crawler refused an off-site seed redirect it records where the seed resolved
// to in the crawl's `seedUrl`; the report surfaces that as `finalUrl` so the
// redirect stays visible without ever moving the base. Both assembly paths (v1
// and the bounded v2) must agree.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildV2Report,
  emptyRuleExecutionResult,
  type StreamingReportInput,
} from "../src/report-stream";
import { generateReportFromStorage } from "../src/adapter";

const EMPTY_STATS = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function streamingInput(): StreamingReportInput {
  return { ...emptyRuleExecutionResult(), tallies: new Map() };
}

async function reportsFor(crawl: { baseUrl: string; seedUrl?: string }) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: crawl.baseUrl,
        seedUrl: crawl.seedUrl,
        originalUrl: crawl.baseUrl,
        startedAt: Date.now(),
        status: "completed",
        // Report assembly reads no config field on this path.
        config: {} as never,
        stats: EMPTY_STATS,
      });
      const v1 = yield* generateReportFromStorage(storage, crawlId, emptyRuleExecutionResult());
      const v2 = yield* buildV2Report(storage, crawlId, streamingInput());
      return { v1, v2 };
    }),
  );
}

describe("report finalUrl", () => {
  test("records a refused off-site seed redirect without moving baseUrl", async () => {
    const { v1, v2 } = await reportsFor({
      baseUrl: "https://example.com",
      seedUrl: "https://parked.example.net/lander",
    });

    for (const report of [v1, v2]) {
      expect(report.baseUrl).toBe("https://example.com");
      expect(report.finalUrl).toBe("https://parked.example.net/lander");
    }
  });

  test("is absent when the seed resolved within the audited origin", async () => {
    const { v1, v2 } = await reportsFor({
      baseUrl: "https://www.example.com",
      seedUrl: "https://www.example.com/en",
    });

    for (const report of [v1, v2]) {
      expect(report.baseUrl).toBe("https://www.example.com");
      expect("finalUrl" in report).toBe(false);
    }
  });

  test("is absent when there was no seed redirect at all", async () => {
    const { v1, v2 } = await reportsFor({ baseUrl: "https://example.com" });

    for (const report of [v1, v2]) {
      expect("finalUrl" in report).toBe(false);
    }
  });
});
