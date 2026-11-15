// `noCache` sends Cache-Control: no-cache on page fetches (#2032); off by default.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { NO_CACHE_HEADERS, createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "https://nc.invalid";
const PAGE = "<!doctype html><html><head><title>t</title></head><body></body></html>";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname.endsWith(".invalid")) {
      return Promise.reject(new TypeError("fetch failed: host does not resolve (test stub)"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function response(url: string, extraHeaders: Record<string, string> = {}): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"', ...extraHeaders },
    body: PAGE,
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
  incremental: false,
  useCacheControl: false,
  maxPages: 5,
};

async function crawl(
  extra: Record<string, unknown>,
  opts: { storage?: CrawlStorage; responseHeaders?: Record<string, string> } = {},
) {
  const sent: Array<Record<string, string>> = [];
  const documentFetcher: DocumentFetcher = {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      sent.push({ ...(req.headers ?? {}) });
      return response(req.url, opts.responseHeaders);
    },
  };
  const storage: CrawlStorage = opts.storage ?? (await Effect.runPromise(createTestStorage()));
  const config = { ...baseConfig, ...extra };
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config,
      stats,
    }),
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
    }),
  );
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...config, documentFetcher }, storage }),
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  const meta = await Effect.runPromise(storage.getCrawl(crawlId));
  return { sent, meta };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

describe("no-cache page fetches (#2032)", () => {
  test("off by default: no Cache-Control or Pragma is sent", async () => {
    const { sent, meta } = await crawl({});
    expect(sent.length).toBeGreaterThan(0);
    for (const h of sent) {
      expect(lower(h)["cache-control"]).toBeUndefined();
      expect(lower(h)["pragma"]).toBeUndefined();
    }
    expect(meta?.config.noCache).toBeUndefined();
  }, 30_000);

  test("noCache sends Cache-Control: no-cache and records it on the crawl", async () => {
    const { sent, meta } = await crawl({ noCache: true });
    expect(sent.length).toBeGreaterThan(0);
    for (const h of sent) {
      expect(lower(h)["cache-control"]).toBe(NO_CACHE_HEADERS["Cache-Control"]);
      expect(lower(h)["pragma"]).toBe("no-cache");
    }
    expect(meta?.config.noCache).toBe(true);
  }, 30_000);

  test("a custom Cache-Control header wins over the no-cache default", async () => {
    const { sent } = await crawl({ noCache: true, headers: { "cache-control": "max-age=0" } });
    for (const h of sent) expect(lower(h)["cache-control"]).toBe("max-age=0");
  }, 30_000);

  // Planning review: a no-cache run must not reuse a page cached by an earlier audit without a
  // request (origin-fresh max-age, or stale-while-revalidate), even though incremental and
  // useCacheControl are on by default. It revalidates with a conditional GET instead.
  for (const [label, cacheControl] of [
    ["fresh max-age", "max-age=3600"],
    ["stale-while-revalidate", "max-age=0, stale-while-revalidate=86400"],
  ] as const) {
    test(`noCache revalidates a ${label} cached page instead of reusing it`, async () => {
      const storage = await Effect.runPromise(createTestStorage());
      const responseHeaders = { "cache-control": cacheControl };
      await crawl({}, { storage, responseHeaders });

      // Control: without noCache the incremental re-run serves the cached copy with no request.
      const reuse = await crawl(
        { incremental: true, useCacheControl: true },
        { storage, responseHeaders },
      );
      expect(reuse.sent.length).toBe(0);

      const { sent } = await crawl(
        { incremental: true, useCacheControl: true, noCache: true },
        { storage, responseHeaders },
      );
      expect(sent.length).toBeGreaterThan(0);
      const root = lower(sent[0]!);
      expect(root["cache-control"]).toBe("no-cache");
      expect(root["if-none-match"]).toBe('"v1"');
    }, 30_000);
  }
});
