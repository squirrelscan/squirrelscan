// #265 per-host throttle: slots stagger by request START (not completion), the
// maxPages cap stays exact under higher concurrency, and robots.txt Crawl-delay
// still overrides per_host_delay_ms.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../../src/crawler/storage/types";

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

const baseConfig = {
  delayMs: 0,
  timeoutMs: 5000,
  userAgent: "test",
  followRedirects: true,
  respectRobots: false,
  incremental: false,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
};

async function seedFrontier(
  storage: CrawlStorage,
  crawlId: string,
  urls: string[]
) {
  for (const url of urls) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: url,
        rawUrl: url,
        depth: 0,
        priority: 1,
        status: "pending" as const,
        source: "seed" as const,
        enqueuedAt: Date.now(),
        retryCount: 0,
      })
    );
  }
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

describe("per-host throttle (#265)", () => {
  test("slots stagger by request start, reaching full per-host concurrency", async () => {
    const PER_HOST = 4;
    const DELAY = 50;
    const LATENCY = 300; // >> PER_HOST * DELAY, so all slots stay busy together

    let t0 = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];

    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        starts.push(Date.now() - t0);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, LATENCY));
        inFlight--;
        return mockResponse(req.url);
      },
    };

    const config = {
      ...baseConfig,
      maxPages: 20,
      concurrency: 8,
      perHostConcurrency: PER_HOST,
      perHostDelayMs: DELAY,
      allowedDomains: ["h.invalid"],
    };

    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "http://h.invalid",
        seedUrl: "http://h.invalid/",
        originalUrl: "http://h.invalid/",
        startedAt: Date.now(),
        status: "paused",
        config,
        stats: emptyStats,
      })
    );

    const urls = Array.from({ length: 12 }, (_, i) => `http://h.invalid/${i}`);
    await seedFrontier(storage, crawlId, urls);

    const crawler = await Effect.runPromise(
      createCrawler({
        config: { ...config, documentFetcher: fetcher },
        storage,
      })
    );

    t0 = Date.now();
    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages.length).toBe(12);

    // Full per-host concurrency genuinely reached (slots overlap).
    expect(maxInFlight).toBe(PER_HOST);

    // The first PER_HOST starts are staggered ~DELAY apart, NOT simultaneous —
    // the old shared-lastFetchAt code fired them together (spread ~0).
    const firstStarts = [...starts].sort((a, b) => a - b).slice(0, PER_HOST);
    const spread = firstStarts[PER_HOST - 1] - firstStarts[0];
    expect(spread).toBeGreaterThanOrEqual((PER_HOST - 1) * DELAY * 0.6);

    await Effect.runPromise(storage.close());
  }, 30000);

  test("maxPages cap stays exact under high concurrency (no overshoot)", async () => {
    let fetchCount = 0;
    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 10));
        return mockResponse(req.url);
      },
    };

    const config = {
      ...baseConfig,
      maxPages: 10,
      concurrency: 10,
      perHostConcurrency: 5,
      perHostDelayMs: 0,
      allowedDomains: ["h.invalid"],
    };

    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "http://h.invalid",
        seedUrl: "http://h.invalid/",
        originalUrl: "http://h.invalid/",
        startedAt: Date.now(),
        status: "paused",
        config,
        stats: emptyStats,
      })
    );

    // 30 pending URLs but a 10-page budget — workers dispatch near the cap.
    const urls = Array.from({ length: 30 }, (_, i) => `http://h.invalid/${i}`);
    await seedFrontier(storage, crawlId, urls);

    const crawler = await Effect.runPromise(
      createCrawler({
        config: { ...config, documentFetcher: fetcher },
        storage,
      })
    );

    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages.length).toBe(10); // exact cap, no overshoot
    expect(fetchCount).toBe(10); // no wasted fetches past the budget

    await Effect.runPromise(storage.close());
  }, 30000);

  test("robots.txt Crawl-delay overrides per_host_delay_ms", async () => {
    const CRAWL_DELAY_MS = 300; // robots "Crawl-delay: 0.3"
    const requests: Array<{ path: string; t: number }> = [];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push({ path: url.pathname, t: Date.now() });
        if (url.pathname === "/robots.txt") {
          return new Response("User-agent: *\nCrawl-delay: 0.3\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (url.pathname === "/") {
          return new Response(
            '<!doctype html><html><head><title>root</title></head><body><a href="/a">a</a><a href="/b">b</a></body></html>',
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        if (url.pathname === "/a" || url.pathname === "/b") {
          return new Response(
            "<!doctype html><html><head><title>p</title></head><body>x</body></html>",
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}/`;
      const config = {
        ...baseConfig,
        respectRobots: true,
        maxPages: 3,
        concurrency: 4,
        perHostConcurrency: 2,
        perHostDelayMs: 50, // would space ~50ms apart if robots were ignored
      };

      const storage = await Effect.runPromise(createTestStorage());
      const crawler = await Effect.runPromise(
        createCrawler({ config, storage })
      );

      await Effect.runPromise(crawler.start(root));

      const a = requests.find((r) => r.path === "/a");
      const b = requests.find((r) => r.path === "/b");
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // The two discovered pages are spaced by the robots Crawl-delay (~300ms),
      // not the 50ms per_host_delay_ms — proving the override still wins.
      const gap = Math.abs(b!.t - a!.t);
      expect(gap).toBeGreaterThanOrEqual(CRAWL_DELAY_MS * 0.6);

      await Effect.runPromise(storage.close());
    } finally {
      server.stop(true);
    }
  }, 30000);

  test("#790: respectRobots=false ignores Crawl-delay, uses per_host_delay_ms", async () => {
    const requests: Array<{ path: string; t: number }> = [];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push({ path: url.pathname, t: Date.now() });
        if (url.pathname === "/robots.txt") {
          // Still fetched (#790) — but Crawl-delay must not apply.
          return new Response("User-agent: *\nCrawl-delay: 0.3\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (url.pathname === "/") {
          return new Response(
            '<!doctype html><html><head><title>root</title></head><body><a href="/a">a</a><a href="/b">b</a></body></html>',
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        if (url.pathname === "/a" || url.pathname === "/b") {
          return new Response(
            "<!doctype html><html><head><title>p</title></head><body>x</body></html>",
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}/`;
      const config = {
        ...baseConfig,
        respectRobots: false,
        maxPages: 3,
        concurrency: 4,
        perHostConcurrency: 2,
        perHostDelayMs: 50,
      };

      const storage = await Effect.runPromise(createTestStorage());
      const crawler = await Effect.runPromise(
        createCrawler({ config, storage })
      );

      await Effect.runPromise(crawler.start(root));

      // robots.txt was still fetched even though it's not enforced.
      const robotsFetched = requests.some((r) => r.path === "/robots.txt");
      expect(robotsFetched).toBe(true);

      const a = requests.find((r) => r.path === "/a");
      const b = requests.find((r) => r.path === "/b");
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Spaced by per_host_delay_ms (~50ms), not the robots Crawl-delay
      // (300ms) — disabled respectRobots ignores it entirely.
      const gap = Math.abs(b!.t - a!.t);
      expect(gap).toBeLessThan(200);

      await Effect.runPromise(storage.close());
    } finally {
      server.stop(true);
    }
  }, 30000);

  test("#790: robots.txt Crawl-delay is capped at 2s even when respectRobots is true", async () => {
    const requests: Array<{ path: string; t: number }> = [];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push({ path: url.pathname, t: Date.now() });
        if (url.pathname === "/robots.txt") {
          // Crawl-delay: 10 (10s) — must be capped at 2s, not honored in full.
          return new Response("User-agent: *\nCrawl-delay: 10\n", {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (url.pathname === "/") {
          return new Response(
            '<!doctype html><html><head><title>root</title></head><body><a href="/a">a</a><a href="/b">b</a></body></html>',
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        if (url.pathname === "/a" || url.pathname === "/b") {
          return new Response(
            "<!doctype html><html><head><title>p</title></head><body>x</body></html>",
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}/`;
      const config = {
        ...baseConfig,
        respectRobots: true,
        maxPages: 3,
        concurrency: 4,
        perHostConcurrency: 2,
        perHostDelayMs: 50,
      };

      const storage = await Effect.runPromise(createTestStorage());
      const crawler = await Effect.runPromise(
        createCrawler({ config, storage })
      );

      await Effect.runPromise(crawler.start(root));

      const a = requests.find((r) => r.path === "/a");
      const b = requests.find((r) => r.path === "/b");
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // Capped at ~2000ms, nowhere near the declared 10000ms.
      const gap = Math.abs(b!.t - a!.t);
      expect(gap).toBeGreaterThanOrEqual(2000 * 0.6);
      expect(gap).toBeLessThan(4000);

      await Effect.runPromise(storage.close());
    } finally {
      server.stop(true);
    }
  }, 30000);

  test("sequential mode (perHostConcurrency=1) still spaces starts by the delay", async () => {
    const DELAY = 50;
    let t0 = 0;
    const starts: number[] = [];

    const fetcher: DocumentFetcher = {
      id: "mock",
      capabilities: { jsRendering: false, cookies: false, screenshot: false },
      async fetch(req) {
        starts.push(Date.now() - t0);
        await new Promise((r) => setTimeout(r, 5)); // fast: delay dominates, not latency
        return mockResponse(req.url);
      },
    };

    const config = {
      ...baseConfig,
      maxPages: 20,
      concurrency: 8,
      perHostConcurrency: 1,
      perHostDelayMs: DELAY,
      allowedDomains: ["h.invalid"],
    };

    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await Effect.runPromise(
      storage.createCrawl({
        baseUrl: "http://h.invalid",
        seedUrl: "http://h.invalid/",
        originalUrl: "http://h.invalid/",
        startedAt: Date.now(),
        status: "paused",
        config,
        stats: emptyStats,
      })
    );

    const urls = Array.from({ length: 5 }, (_, i) => `http://h.invalid/${i}`);
    await seedFrontier(storage, crawlId, urls);

    const crawler = await Effect.runPromise(
      createCrawler({
        config: { ...config, documentFetcher: fetcher },
        storage,
      })
    );

    t0 = Date.now();
    await Effect.runPromise(crawler.resumeFromStorage(crawlId));

    const ordered = [...starts].sort((a, b) => a - b);
    expect(ordered.length).toBe(5);
    // Each consecutive start is spaced ~DELAY apart — the single slot does not
    // collapse to back-to-back fetches; politeness holds in sequential mode.
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i] - ordered[i - 1]).toBeGreaterThanOrEqual(DELAY * 0.6);
    }

    await Effect.runPromise(storage.close());
  }, 30000);
});
