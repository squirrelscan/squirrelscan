// Re-audits must not reuse stored pages on shared-cache rules (#2229): s-maxage is ignored and a
// stale-while-revalidate window triggers a conditional GET instead of silent reuse.

import type { CrawlerConfigSnapshot } from "@squirrelscan/core-contracts";
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "https://swr.invalid";
const CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const OLD_BODY =
  "<!doctype html><html><head><title>old</title></head><body>OLD</body></html>";
const NEW_BODY =
  "<!doctype html><html><head><title>new</title></head><body>NEW</body></html>";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(url).hostname.endsWith(".invalid")) {
      return Promise.reject(new TypeError("fetch failed (test stub)"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function response(
  url: string,
  status: number,
  body: string,
  etag: string
): FetchResponse {
  return {
    url,
    finalUrl: url,
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      etag,
      "cache-control": CACHE_CONTROL,
    },
    body,
    timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [{ url, statusCode: status, type: "http" as const }],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  };
}

const stats = {
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
  incremental: true,
  useCacheControl: true,
  maxPages: 5,
};

type Origin = { body: string; etag: string };

async function crawl(storage: CrawlStorage, origin: Origin) {
  const sent: Array<Record<string, string>> = [];
  const documentFetcher: DocumentFetcher = {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      const headers = { ...(req.headers ?? {}) };
      sent.push(headers);
      const inm = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === "if-none-match"
      )?.[1];
      if (inm === origin.etag) return response(req.url, 304, "", origin.etag);
      return response(req.url, 200, origin.body, origin.etag);
    },
  };
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config: baseConfig as unknown as CrawlerConfigSnapshot, // tests record a partial snapshot
      stats,
    })
  );
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
    })
  );
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...baseConfig, documentFetcher }, storage })
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  const pages = await Effect.runPromise(storage.getPages(crawlId));
  return { sent, bodies: pages.map((p) => p.html ?? "") };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

describe("re-audit reuse ignores s-maxage and swr (#2229)", () => {
  test("+301s: conditional request sent; 200 reports the new body, 304 keeps the stored one", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const run1 = await crawl(storage, { body: OLD_BODY, etag: '"v1"' });
    expect(run1.sent.length).toBe(1);

    const realNow = Date.now.bind(Date);
    let offsetMs = 301_000;
    const spy = spyOn(Date, "now").mockImplementation(
      () => realNow() + offsetMs
    );
    try {
      // Origin changed: 200 with the new body replaces the stored one.
      const run2 = await crawl(storage, { body: NEW_BODY, etag: '"v2"' });
      expect(run2.sent.length).toBe(1);
      expect(lower(run2.sent[0]!)["if-none-match"]).toBe('"v1"');
      expect(run2.bodies.join("")).toContain("NEW");

      // Origin unchanged, another 301s on: 304 keeps the stored body.
      offsetMs += 301_000;
      const run3 = await crawl(storage, { body: NEW_BODY, etag: '"v2"' });
      expect(run3.sent.length).toBe(1);
      expect(lower(run3.sent[0]!)["if-none-match"]).toBe('"v2"');
      expect(run3.bodies.join("")).toContain("NEW");
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  test("inside max-age the stored page is still reused with no request", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    await crawl(storage, { body: OLD_BODY, etag: '"v1"' });
    const run2 = await crawl(storage, { body: NEW_BODY, etag: '"v2"' });
    expect(run2.sent.length).toBe(0);
  }, 30_000);
});
