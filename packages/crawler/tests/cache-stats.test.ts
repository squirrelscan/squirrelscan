// Unit tests for the buildCacheStats aggregator (#108).

import { describe, expect, test } from "bun:test";

import {
  buildCacheStats,
  type CrawlStats,
  type ResourceSizeRecord,
} from "@squirrelscan/core-contracts";

function stats(overrides: Partial<CrawlStats> = {}): CrawlStats {
  return {
    pagesTotal: 0,
    pagesFetched: 0,
    pagesFailed: 0,
    pagesSkipped: 0,
    pagesUnchanged: 0,
    linksTotal: 0,
    imagesTotal: 0,
    bytesTotal: 0,
    avgLoadTimeMs: 0,
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceSizeRecord> = {}): ResourceSizeRecord {
  return {
    type: "css",
    url: "https://example.com/a.css",
    status: 200,
    error: null,
    contentType: "text/css",
    sizeBytes: 1000,
    sourcePages: [],
    ...overrides,
  };
}

describe("buildCacheStats", () => {
  test("returns null when nothing is cacheable", () => {
    expect(buildCacheStats(null, [])).toBeNull();
    expect(buildCacheStats(stats(), [])).toBeNull();
  });

  test("returns null on a cold run (pages/resources fetched but ZERO hits)", () => {
    // A first crawl fetches pages + resources but reuses nothing — omit the
    // panel rather than render a misleading "0% hit rate".
    const cold = buildCacheStats(stats({ pagesFetched: 5 }), [
      resource({ url: "a.css", cacheReason: null, sizeBytes: 1000 }),
      resource({ url: "b.css", cacheReason: null, sizeBytes: 2000 }),
    ]);
    expect(cold).toBeNull();
  });

  test("aggregates page hits + bytes saved + hit rate", () => {
    const result = buildCacheStats(
      stats({
        pagesFetched: 6,
        pagesUnchanged: 4,
        bytesCacheSaved: 4096,
        cacheHitsByReason: { "max-age": 3, "304": 1 },
      })
    );
    expect(result).not.toBeNull();
    expect(result!.total).toBe(10); // fetched 6 + unchanged 4
    expect(result!.hits).toBe(4);
    expect(result!.hitRate).toBeCloseTo(0.4, 5);
    expect(result!.bytesSaved).toBe(4096);
    expect(result!.hitsByReason).toEqual({ "max-age": 3, "304": 1 });
    expect(result!.pages).toEqual({ total: 10, hits: 4, bytesSaved: 4096 });
    expect(result!.resources).toEqual({ total: 0, hits: 0, bytesSaved: 0 });
  });

  test("counts a sub-resource hit only when cacheReason is set", () => {
    const records = [
      resource({ url: "a.css", cacheReason: "max-age", transferBytes: 0, sizeBytes: 500 }),
      resource({ url: "b.css", cacheReason: "304", transferBytes: 0, sizeBytes: 800 }),
      resource({ url: "c.css", cacheReason: null, transferBytes: 1200, sizeBytes: 1200 }),
    ];
    const result = buildCacheStats(stats(), records);
    expect(result).not.toBeNull();
    expect(result!.resources).toEqual({ total: 3, hits: 2, bytesSaved: 1300 });
    expect(result!.total).toBe(3);
    expect(result!.hits).toBe(2);
    expect(result!.hitsByReason).toEqual({ "max-age": 1, "304": 1 });
  });

  test("merges page + sub-resource reasons and bytes without double-counting", () => {
    const result = buildCacheStats(
      stats({
        pagesFetched: 2,
        pagesUnchanged: 2,
        bytesCacheSaved: 1000,
        cacheHitsByReason: { "304": 2 },
      }),
      [
        resource({ url: "a.css", cacheReason: "304", transferBytes: 0, sizeBytes: 300 }),
        resource({ url: "b.css", cacheReason: "max-age", transferBytes: 0, sizeBytes: 700 }),
      ]
    );
    expect(result!.total).toBe(6); // 4 pages + 2 resources
    expect(result!.hits).toBe(4); // 2 pages + 2 resources
    expect(result!.bytesSaved).toBe(2000); // 1000 page + 1000 resource
    expect(result!.hitsByReason).toEqual({ "304": 3, "max-age": 1 });
  });

  test("falls back to sizeBytes when transferBytes is absent for a hit", () => {
    const result = buildCacheStats(stats(), [
      resource({ url: "a.css", cacheReason: "max-age", sizeBytes: 555 }),
    ]);
    expect(result!.resources.bytesSaved).toBe(555);
  });
});
