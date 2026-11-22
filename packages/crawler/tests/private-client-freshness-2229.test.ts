// pub#2229: the crawler is a private client. s-maxage (shared caches only) must
// not set the lifetime, and a stale entry inside stale-while-revalidate must be
// revalidated with a conditional GET, never reused without a request.

import type { CrawlerConfigSnapshot } from "@squirrelscan/core-contracts";
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { calculateFreshness } from "../src/incremental";
import { createTestStorage } from "../src/storage";

const SEC = 1000;
const now = 1_700_000_000_000;

function fresh(cacheControl: string, ageSec: number) {
  return calculateFreshness(
    { cacheControl, expires: null, age: null, fetchedAt: now - ageSec * SEC },
    { now }
  );
}

describe("calculateFreshness ignores s-maxage (#2229)", () => {
  test("max-age=300, s-maxage=3600: fresh at 299 s, not fresh at 301 s", () => {
    const cc = "max-age=300, s-maxage=3600";
    expect(fresh(cc, 299).state).toBe("fresh");
    expect(fresh(cc, 299).reason).toBe("max-age");
    expect(fresh(cc, 301).state).toBe("stale");
  });

  test("s-maxage alone gives no lifetime: conditional GET", () => {
    const r = fresh("s-maxage=3600", 10);
    expect(r.state).toBe("stale");
    expect(r.lifetimeSeconds).toBeUndefined();
  });

  test("stale-while-revalidate window is a conditional GET, never reuse", () => {
    const r = fresh("max-age=300, stale-while-revalidate=86400", 301);
    expect(r.state).toBe("stale");
    expect(r.reason).toBe("stale-while-revalidate");
  });

  test("immutable, no-cache, no-store and the staleness cap are unchanged", () => {
    expect(fresh("max-age=31536000, immutable", 100).reason).toBe("immutable");
    expect(fresh("no-cache, max-age=300", 1).state).toBe("stale");
    expect(fresh("no-store, max-age=300", 1).state).toBe("stale");
    const capped = calculateFreshness(
      {
        cacheControl: "max-age=999999999",
        expires: null,
        age: null,
        fetchedAt: now - 90_000 * SEC,
      },
      { now }
    );
    expect(capped.reason).toBe("staleness-cap");
  });
});

// ---- crawl level ----

const ORIGIN = "http://h.invalid";
const CC = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function respond(
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
      "cache-control": CC,
      etag,
    },
    body: status === 304 ? "" : body,
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

const page = (t: string) =>
  `<!doctype html><html><head><title>${t}</title></head><body>${t}</body></html>`;

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
  maxPages: 5,
};

async function runCrawl(
  storage: CrawlStorage,
  cfg: Record<string, unknown>,
  fetcher: DocumentFetcher
): Promise<string> {
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config: cfg as unknown as CrawlerConfigSnapshot, // partial snapshot
      stats: emptyStats,
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
    createCrawler({ config: { ...cfg, documentFetcher: fetcher }, storage })
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  return crawlId;
}

function fetcherFor(
  origin: { body: string; etag: string },
  seen: Array<Record<string, string>>
): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      const headers = Object.fromEntries(
        Object.entries(req.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ])
      );
      seen.push(headers);
      if (headers["if-none-match"] === origin.etag) {
        return respond(req.url, 304, "", origin.etag);
      }
      return respond(req.url, 200, origin.body, origin.etag);
    },
  };
}

describe("incremental re-audit with CDN cache headers (#2229)", () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  async function setup() {
    const storage = await Effect.runPromise(createTestStorage());
    const origin = { body: page("old"), etag: '"v1"' };
    const seen1: Array<Record<string, string>> = [];
    await runCrawl(
      storage,
      { ...baseConfig, incremental: false, useCacheControl: false },
      fetcherFor(origin, seen1)
    );
    expect(seen1.length).toBe(1);
    return { storage, origin };
  }

  const cfg2 = {
    ...baseConfig,
    incremental: true,
    useCacheControl: true,
    maxStalenessSeconds: 999_999,
  };

  async function bodyOf(storage: CrawlStorage, crawlId: string) {
    const pages = await Effect.runPromise(storage.getPages(crawlId));
    expect(pages.length).toBe(1);
    return pages[0]!;
  }

  test("+301 s, origin changed: conditional GET, 200 records the new body", async () => {
    const { storage, origin } = await setup();
    origin.body = page("new");
    origin.etag = '"v2"';
    const t0 = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => t0 + 301 * SEC);
    try {
      const seen: Array<Record<string, string>> = [];
      const id = await runCrawl(storage, cfg2, fetcherFor(origin, seen));
      expect(seen.length).toBe(1);
      expect(seen[0]!["if-none-match"]).toBe('"v1"');
      expect((await bodyOf(storage, id)).html).toContain("new");
    } finally {
      spy.mockRestore();
    }
    await Effect.runPromise(storage.close());
  }, 30000);

  test("+301 s, origin unchanged: 304 keeps the stored body", async () => {
    const { storage, origin } = await setup();
    const t0 = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => t0 + 301 * SEC);
    try {
      const seen: Array<Record<string, string>> = [];
      const id = await runCrawl(storage, cfg2, fetcherFor(origin, seen));
      expect(seen.length).toBe(1);
      expect(seen[0]!["if-none-match"]).toBe('"v1"');
      const p = await bodyOf(storage, id);
      expect(p.html).toContain("old");
    } finally {
      spy.mockRestore();
    }
    await Effect.runPromise(storage.close());
  }, 30000);

  test("+200 s, inside max-age: stored page reused with no request", async () => {
    const { storage, origin } = await setup();
    const t0 = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => t0 + 200 * SEC);
    try {
      const seen: Array<Record<string, string>> = [];
      const id = await runCrawl(storage, cfg2, fetcherFor(origin, seen));
      expect(seen.length).toBe(0);
      expect((await bodyOf(storage, id)).html).toContain("old");
    } finally {
      spy.mockRestore();
    }
    await Effect.runPromise(storage.close());
  }, 30000);
});
