// Regression test: the crawl loop must run batches at the GLOBAL concurrency
// limit, with per-host parallelism enforced by the host scheduler — not cap
// the whole batch at perHostConcurrency (which serialised multi-host crawls
// and convoyed cloud-render crawls).
//
// Uses resumeFromStorage with a pre-seeded frontier so the test is fully
// offline (no redirect detection / sitemap discovery network calls).

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../../src/crawler/core";
import { createTestStorage } from "../../src/crawler/storage";

function mockResponse(url: string) {
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
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

describe("crawl loop concurrency", () => {
  test("multi-host batch runs hosts in parallel despite perHostConcurrency=1", async () => {
    const inFlightByHost = new Map<string, number>();
    let inFlight = 0;
    let maxInFlight = 0;
    let maxPerHost = 0;

    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        const host = new URL(req.url).host;
        inFlight++;
        inFlightByHost.set(host, (inFlightByHost.get(host) ?? 0) + 1);
        maxInFlight = Math.max(maxInFlight, inFlight);
        maxPerHost = Math.max(maxPerHost, inFlightByHost.get(host)!);
        await new Promise((r) => setTimeout(r, 50));
        inFlightByHost.set(host, inFlightByHost.get(host)! - 1);
        inFlight--;
        return mockResponse(req.url);
      },
    };

    const config = {
      maxPages: 10,
      concurrency: 4,
      perHostConcurrency: 1,
      delayMs: 0,
      perHostDelayMs: 0,
      timeoutMs: 5000,
      userAgent: "test",
      followRedirects: true,
      respectRobots: false,
      incremental: false,
      include: [],
      exclude: [],
      allowQueryParams: [],
      dropQueryPrefixes: [],
      allowedDomains: ["a.invalid", "b.invalid"],
    };

    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "http://a.invalid",
        seedUrl: "http://a.invalid/",
        originalUrl: "http://a.invalid/",
        startedAt: Date.now(),
        status: "paused",
        config,
        stats: {
          pagesTotal: 0,
          pagesFetched: 0,
          pagesFailed: 0,
          pagesSkipped: 0,
          pagesUnchanged: 0,
          linksTotal: 0,
          imagesTotal: 0,
          bytesTotal: 0,
          avgLoadTimeMs: 0,
        },
      })
    );

    // Pre-seed frontier with two hosts, two urls each
    const urls = [
      "http://a.invalid/1",
      "http://a.invalid/2",
      "http://b.invalid/1",
      "http://b.invalid/2",
    ];
    for (const url of urls) {
      await Effect.runPromise(
        storage.upsertFrontier(crawlId, {
          normalizedUrl: url,
          rawUrl: url,
          depth: 0,
          priority: 1,
          status: "pending",
          source: "seed",
          enqueuedAt: Date.now(),
          retryCount: 0,
        })
      );
    }

    const crawler = await Effect.runPromise(
      createCrawler({
        config: { ...config, documentFetcher: fetcher },
        storage,
      })
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    // All pages from both hosts crawled
    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages.map((p) => p.url).sort()).toEqual(urls);

    // Per-host cap respected, but hosts ran in parallel. With the old code
    // (Effect.all capped at perHostConcurrency=1) maxInFlight was 1.
    expect(maxPerHost).toBe(1);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);

    await Effect.runPromise(storage.close());
  }, 30000);
});
