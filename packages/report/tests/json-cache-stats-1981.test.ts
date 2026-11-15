// #1981: renderJson carries cacheStats when the audit reused anything, and omits it on a cold audit.

import { describe, expect, test } from "bun:test";

import type { CacheStats } from "@squirrelscan/core-contracts";
import { buildCacheStats } from "@squirrelscan/core-contracts";
import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 1,
    failed: 2,
    ruleResults: {},
    ...overrides,
  };
}

const crawl = (over: Record<string, unknown>) =>
  ({
    pagesFetched: 0,
    pagesUnchanged: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
    bytesTransferred: 0,
    bytesCacheSaved: 0,
    cacheHitsByReason: {},
    ...over,
  }) as never;

describe("renderJson cacheStats (#1981)", () => {
  test("a warm audit's JSON carries cacheStats and a cold audit's does not", () => {
    const cold = JSON.parse(
      renderJson(
        baseReport({ cacheStats: buildCacheStats(crawl({ pagesFetched: 10 })) ?? undefined }),
      ),
    );
    const warmStats = buildCacheStats(
      crawl({ pagesUnchanged: 10, cacheHitsByReason: { "stale-while-revalidate": 10 } }),
    ) as CacheStats;
    const warm = JSON.parse(renderJson(baseReport({ cacheStats: warmStats })));
    expect("cacheStats" in cold).toBe(false);
    expect(warm.cacheStats.hits).toBe(10);
    expect(warm.cacheStats.hitsByReason).toEqual({ "stale-while-revalidate": 10 });
    expect(warm.cacheStats.pages.total).toBe(10);
    expect(JSON.stringify(warm)).not.toBe(JSON.stringify(cold));
  });

  test("a zero-hit cacheStats is omitted, not emitted as zeros", () => {
    const zero: CacheStats = {
      total: 3,
      hits: 0,
      hitRate: 0,
      bytesSaved: 0,
      hitsByReason: {},
      pages: { total: 3, hits: 0, bytesSaved: 0 },
      resources: { total: 0, hits: 0, bytesSaved: 0 },
    };
    expect("cacheStats" in JSON.parse(renderJson(baseReport({ cacheStats: zero })))).toBe(false);
    expect("cacheStats" in JSON.parse(renderJson(baseReport()))).toBe(false);
  });
});
