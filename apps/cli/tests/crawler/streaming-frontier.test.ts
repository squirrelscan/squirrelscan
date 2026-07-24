// Streaming frontier tests: the crawl loop is a continuous worker pool, not
// a batch barrier. One slow fetch (e.g. a 35s cloud render) must not stall
// unrelated URLs, links discovered mid-flight must become fetchable
// immediately, and maxPages must hold under full concurrency.
//
// Uses resumeFromStorage with a pre-seeded frontier so the tests are fully
// offline (no redirect detection / sitemap discovery network calls).

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../../src/crawler/core";
import { createTestStorage } from "../../src/crawler/storage";

function mockResponse(url: string, body?: string) {
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body:
      body ??
      "<!doctype html><html><head><title>t</title></head><body>x</body></html>",
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

interface TestCrawlConfig {
  maxPages: number;
  concurrency: number;
  perHostConcurrency: number;
  delayMs: number;
  perHostDelayMs: number;
  timeoutMs: number;
  userAgent: string;
  followRedirects: boolean;
  respectRobots: boolean;
  incremental: boolean;
  include: string[];
  exclude: string[];
  allowQueryParams: string[];
  dropQueryPrefixes: string[];
  allowedDomains: string[];
}

function baseConfig(overrides: Partial<TestCrawlConfig> = {}): TestCrawlConfig {
  return {
    maxPages: 50,
    concurrency: 2,
    perHostConcurrency: 2,
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
    ...overrides,
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

async function seedCrawl(
  config: TestCrawlConfig,
  urls: string[],
  fetcher: DocumentFetcher
) {
  const storage = await Effect.runPromise(createTestStorage());
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: "http://a.invalid",
      seedUrl: "http://a.invalid/",
      originalUrl: "http://a.invalid/",
      startedAt: Date.now(),
      status: "paused",
      config,
      stats: emptyStats,
    })
  );

  for (const [i, url] of urls.entries()) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: url,
        rawUrl: url,
        depth: 0,
        priority: i + 1,
        status: "pending",
        source: "seed",
        enqueuedAt: Date.now() + i,
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

  return { storage, crawlId, crawler };
}

describe("streaming frontier", () => {
  test("one slow fetch does not block other URLs (no batch barrier)", async () => {
    // 1 slow URL on host a + 5 fast URLs on host b, concurrency 2.
    // Batch model (batchSize=2): batch 1 = [slow, fast1] → fast2..5 wait for
    // the slow fetch. Streaming: the free worker drains all fast URLs while
    // the slow one is still in flight.
    const fastUrls = [1, 2, 3, 4, 5].map((i) => `http://b.invalid/fast${i}`);
    const slowUrl = "http://a.invalid/slow";

    const completed: string[] = [];
    let fastDone = 0;
    let resolveAllFastDone: (() => void) | undefined;
    const allFastDone = new Promise<void>((resolve) => {
      resolveAllFastDone = resolve;
    });

    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        if (req.url === slowUrl) {
          // Hangs until every fast URL completed (or a generous fallback so a
          // regression fails the ordering assertion instead of hanging).
          await Promise.race([
            allFastDone,
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        } else {
          await new Promise((r) => setTimeout(r, 10));
          fastDone++;
          if (fastDone === fastUrls.length) resolveAllFastDone?.();
        }
        completed.push(req.url);
        return mockResponse(req.url);
      },
    };

    const config = baseConfig({ concurrency: 2, perHostConcurrency: 2 });
    // Slow URL gets top priority so it is dispatched first.
    const { storage, crawlId, crawler } = await seedCrawl(
      config,
      [slowUrl, ...fastUrls],
      fetcher
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages).toHaveLength(6);

    // All fast URLs finished BEFORE the slow one — impossible with a batch
    // barrier where fast2..5 sit behind the slow fetch.
    expect(completed[completed.length - 1]).toBe(slowUrl);
    expect(completed.slice(0, -1).sort()).toEqual([...fastUrls].sort());

    await Effect.runPromise(storage.close());
  }, 30000);

  test("links discovered mid-flight are fetched while a slow fetch is still running", async () => {
    // Seed: slow URL S + page A whose HTML links to B. Streaming: A is
    // processed, B is enqueued and fetched immediately — all while S is
    // still in flight. Batch model: B waits for the [S, A] batch to finish.
    const slowUrl = "http://a.invalid/slow";
    const pageA = "http://a.invalid/a";
    const pageB = "http://a.invalid/b";

    const completed: string[] = [];
    let resolveBDone: (() => void) | undefined;
    const bDone = new Promise<void>((resolve) => {
      resolveBDone = resolve;
    });

    const htmlWithLink = `<!doctype html><html><head><title>a</title></head><body><a href="${pageB}">b</a></body></html>`;

    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        if (req.url === slowUrl) {
          await Promise.race([bDone, new Promise((r) => setTimeout(r, 3000))]);
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
        completed.push(req.url);
        if (req.url === pageB) resolveBDone?.();
        if (req.url === pageA) return mockResponse(req.url, htmlWithLink);
        return mockResponse(req.url);
      },
    };

    const config = baseConfig({ concurrency: 2, perHostConcurrency: 2 });
    const { storage, crawlId, crawler } = await seedCrawl(
      config,
      [slowUrl, pageA],
      fetcher
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages.map((p) => p.normalizedUrl).sort()).toEqual(
      [pageA, pageB, slowUrl].sort()
    );

    // B (discovered while S was in flight) completed before S.
    expect(completed.indexOf(pageB)).toBeGreaterThanOrEqual(0);
    expect(completed.indexOf(pageB)).toBeLessThan(completed.indexOf(slowUrl));

    await Effect.runPromise(storage.close());
  }, 30000);

  test("maxPages is respected under full concurrency (no overshoot)", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `http://a.invalid/p${i}`);

    let fetchCalls = 0;
    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        fetchCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return mockResponse(req.url);
      },
    };

    const config = baseConfig({
      maxPages: 5,
      concurrency: 8,
      perHostConcurrency: 8,
      allowedDomains: ["a.invalid"],
    });
    const { storage, crawlId, crawler } = await seedCrawl(
      config,
      urls,
      fetcher
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages).toHaveLength(5);
    // Budget reservation: never dispatch more fetches than the page budget.
    expect(fetchCalls).toBeLessThanOrEqual(5);

    await Effect.runPromise(storage.close());
  }, 30000);

  test("failed fetches free their page-budget reservation", async () => {
    // maxPages=3, 5 URLs, the first two fetches fail. Failures store no page
    // record, so the pool must keep dispatching until 3 pages are stored.
    const urls = Array.from({ length: 5 }, (_, i) => `http://a.invalid/f${i}`);

    let calls = 0;
    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        if (calls <= 2) throw new Error("boom");
        return mockResponse(req.url);
      },
    };

    const config = baseConfig({
      maxPages: 3,
      concurrency: 2,
      perHostConcurrency: 2,
      allowedDomains: ["a.invalid"],
    });
    const { storage, crawlId, crawler } = await seedCrawl(
      config,
      urls,
      fetcher
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages).toHaveLength(3);

    await Effect.runPromise(storage.close());
  }, 30000);
});
