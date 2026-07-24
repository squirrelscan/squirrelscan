// #824 — a fully-cached page does zero network, so it must NOT pay the per-host
// stagger. The delay/emit are hoisted below the cache-freshness short-circuit;
// this drives a real two-pass incremental crawl and asserts pass 2 (all pages
// cache-fresh) does no fetches and does not sleep off the per-host delay.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";

// Build an HTML body linking to the given absolute paths (for link discovery).
function html(...links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps every stored page "fresh" on the re-run (skip request).
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

// A hub: root links to N leaves. 1 + N pages, all same host.
function hubSite(n: number): Record<string, string> {
  const leaves = Array.from({ length: n }, (_, i) => `/p${i}`);
  const site: Record<string, string> = { [`${ORIGIN}/`]: html(...leaves) };
  for (const p of leaves) site[`${ORIGIN}${p}`] = html();
  return site;
}

async function seedRoot(storage: CrawlStorage, crawlId: string) {
  await Effect.runPromise(
    storage.upsertFrontier(crawlId, {
      normalizedUrl: `${ORIGIN}/`,
      rawUrl: `${ORIGIN}/`,
      depth: 0,
      priority: 1,
      status: "pending" as const,
      source: "seed" as const,
      enqueuedAt: Date.now(),
      retryCount: 0,
    }),
  );
}

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

describe("cache-fresh pages skip the per-host delay (#824)", () => {
  test("re-run of a fully-cached site does zero fetches and pays no stagger", async () => {
    const site = hubSite(5);
    const totalPages = Object.keys(site).length; // 6

    const storage = await Effect.runPromise(createTestStorage());

    // ---- Pass 1: cold crawl populates the cross-audit cache ----
    const pass1Fetched: string[] = [];
    const pass1Fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        pass1Fetched.push(req.url);
        return mockResponse(req.url, site[req.url] ?? html());
      },
    };
    const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
    const crawlId1 = await createCrawlRecord(storage, cfg1);
    await seedRoot(storage, crawlId1);
    const crawler1 = await Effect.runPromise(
      createCrawler({ config: { ...cfg1, documentFetcher: pass1Fetcher }, storage }),
    );
    await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
    // Sanity: the cold crawl really fetched the whole hub.
    expect(new Set(pass1Fetched).size).toBe(totalPages);

    // ---- Pass 2: incremental re-run — every page is cache-fresh ----
    let pass2FetchCount = 0;
    const pass2Fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        pass2FetchCount++;
        return mockResponse(req.url, site[req.url] ?? html());
      },
    };
    const DELAY = 500; // old code: ~(pages-1)*DELAY ≈ 2500ms of pure sleep
    const cfg2 = {
      ...baseConfig,
      incremental: true,
      useCacheControl: true,
      maxStalenessSeconds: 999_999,
      perHostConcurrency: 1,
      perHostDelayMs: DELAY,
    };
    const crawlId2 = await createCrawlRecord(storage, cfg2);
    await seedRoot(storage, crawlId2);
    const crawler2 = await Effect.runPromise(
      createCrawler({ config: { ...cfg2, documentFetcher: pass2Fetcher }, storage }),
    );

    const started = Date.now();
    await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
    const elapsed = Date.now() - started;

    // Every page served from cache — no network at all.
    expect(pass2FetchCount).toBe(0);

    const pages2 = await Effect.runPromise(storage.getPages(crawlId2));
    expect(pages2.length).toBe(totalPages);

    const stats2 = await Effect.runPromise(storage.getStats(crawlId2));
    expect(stats2?.pagesUnchanged).toBe(totalPages);
    expect(stats2?.pagesCacheFresh).toBe(totalPages);

    // The whole point of #824: cache-served pages don't sleep off the stagger.
    // Old code paid ~2500ms here; the hoisted delay makes this near-instant.
    expect(elapsed).toBeLessThan(800);

    await Effect.runPromise(storage.close());
  }, 30000);
});
