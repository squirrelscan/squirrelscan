// #354 — cache reuse must honour disableLinkDiscovery exactly as the fetch path
// does. Drives a real two-pass incremental crawl: pass 1 caches a homepage that
// links to /off-map (not in the sitemap); pass 2 reuses it from cache.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";

function html(...links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

const SITE: Record<string, string> = {
  [`${ORIGIN}/`]: html("/listed", "/off-map"),
  [`${ORIGIN}/listed`]: html(),
  [`${ORIGIN}/off-map`]: html(),
};

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps every stored page fresh on pass 2, so it is reused unfetched.
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" },
    body,
    timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [{ url, statusCode: 200, type: "http" as const }],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  };
}

function fetcherFor(fetched: string[]): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      return mockResponse(req.url, SITE[req.url] ?? html());
    },
  };
}

const emptyStats = {
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

const baseConfig = {
  delayMs: 0,
  timeoutMs: 5000,
  userAgent: "test",
  followRedirects: true,
  respectRobots: false,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
  breadthFirst: false,
  coverageMode: "full" as const,
  allowedDomains: ["h.invalid"],
  maxPages: 50,
};

async function createCrawlRecord(
  storage: CrawlStorage,
  config: Record<string, unknown>,
): Promise<string> {
  return Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config,
      stats: emptyStats,
    }),
  );
}

async function seedFrontier(
  storage: CrawlStorage,
  crawlId: string,
  entries: Array<{ path: string; source: "seed" | "sitemap" }>,
) {
  for (const { path, source } of entries) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: `${ORIGIN}${path}`,
        rawUrl: `${ORIGIN}${path}`,
        depth: source === "seed" ? 0 : 1,
        priority: 1,
        status: "pending" as const,
        source,
        enqueuedAt: Date.now(),
        retryCount: 0,
      }),
    );
  }
}

// Pass 1 caches the whole site; pass 2 is an incremental re-run in which the
// homepage (and every other seeded page) is reused from cache. Returns the URLs
// pass 2 fetched and the URLs that ended up in its frontier.
async function runReusePass(opts: {
  disableLinkDiscovery: boolean;
  sitemapPaths: string[];
}): Promise<{ fetched: string[]; frontier: string[]; unchanged: number }> {
  const storage = await Effect.runPromise(createTestStorage());

  const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
  const crawlId1 = await createCrawlRecord(storage, cfg1);
  await seedFrontier(storage, crawlId1, [{ path: "/", source: "seed" }]);
  const crawler1 = await Effect.runPromise(
    createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([]) }, storage }),
  );
  await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));

  const fetched: string[] = [];
  const cfg2 = {
    ...baseConfig,
    incremental: true,
    useCacheControl: true,
    maxStalenessSeconds: 999_999,
    disableLinkDiscovery: opts.disableLinkDiscovery,
  };
  const crawlId2 = await createCrawlRecord(storage, cfg2);
  await seedFrontier(storage, crawlId2, [
    { path: "/", source: "seed" },
    ...opts.sitemapPaths.map((path) => ({ path, source: "sitemap" as const })),
  ]);
  const crawler2 = await Effect.runPromise(
    createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched) }, storage }),
  );
  await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));

  const entries = await Effect.runPromise(storage.getAllFrontierEntries(crawlId2));
  const stats = await Effect.runPromise(storage.getStats(crawlId2));
  await Effect.runPromise(storage.close());
  return {
    fetched,
    frontier: entries.map((e) => e.normalizedUrl),
    unchanged: stats?.pagesUnchanged ?? 0,
  };
}

const OFF_MAP = `${ORIGIN}/off-map`;

describe("cached page reuse honours disableLinkDiscovery (#354)", () => {
  test("disableLinkDiscovery: a reused page does not enqueue its outlinks", async () => {
    const r = await runReusePass({ disableLinkDiscovery: true, sitemapPaths: ["/listed"] });
    // Sanity: the pages really were reused rather than fetched.
    expect(r.fetched).toEqual([]);
    expect(r.unchanged).toBeGreaterThan(0);
    expect(r.frontier).not.toContain(OFF_MAP);
    expect(r.fetched).not.toContain(OFF_MAP);
  }, 30000);

  test("sitemap fallback: with no crawlable sitemap URLs a reused page's links are discovered", async () => {
    const r = await runReusePass({ disableLinkDiscovery: true, sitemapPaths: [] });
    expect(r.fetched).toEqual([]);
    expect(r.frontier).toContain(OFF_MAP);
  }, 30000);

  test("negative control: disableLinkDiscovery false discovers a reused page's links", async () => {
    const r = await runReusePass({ disableLinkDiscovery: false, sitemapPaths: ["/listed"] });
    expect(r.fetched).toEqual([]);
    expect(r.frontier).toContain(OFF_MAP);
  }, 30000);
});
