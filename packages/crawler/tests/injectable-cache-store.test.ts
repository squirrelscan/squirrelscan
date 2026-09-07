// #1899 — the cache seam is injectable, so a crawl whose previous crawl lives
// somewhere other than this database can still revalidate against it.
//
// The default `StorageCacheStore` reads the previous crawl out of the same
// SQLite the current crawl writes. That is why a CLI re-run is near free and a
// cloud run is not: the container starts empty, so `incremental` has nothing to
// revalidate against and every page is fetched and rendered again.
//
// What matters for the cloud is that the injected store is asked for ONE url at
// a time and that a store which cannot answer costs nothing but a normal fetch.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { CacheLookup, CacheStore } from "../src/cache-store";
import type { CrawlFetcher } from "../src/core/types";
import type { PageRecord } from "../src/storage/types";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const HTML = `<!doctype html><html><head><title>Cached</title></head><body><h1>Cached</h1></body></html>`;

/** A page as a previous crawl stored it, complete with body. */
function priorPage(url: string): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: HTML.length,
    loadTimeMs: 5,
    fetchedAt: Date.now() - 60_000,
    etag: 'W/"prior"',
    lastModified: null,
    contentHash: "prior-hash",
    html: HTML,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: 'W/"prior"',
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  } as PageRecord;
}

/** Records what the crawl asked for, and answers with the given status. */
function trackingFetcher(seen: string[], status: (url: string) => number): CrawlFetcher {
  return ((url: string) => {
    seen.push(url);
    const code = status(url);
    const body = code === 304 ? "" : HTML;
    return Effect.succeed({
      url,
      finalUrl: url,
      status: code,
      loadTime: 1,
      headers: priorPage(url).headers,
      securityHeaders: priorPage(url).securityHeaders,
      contentType: "text/html",
      body,
      sizeBytes: body.length,
      redirectChain: [],
    });
  }) as unknown as CrawlFetcher;
}

describe("injectable cache store (#1899)", () => {
  test("an injected store is consulted, one url at a time", async () => {
    const storage = new SQLiteStorage(":memory:");
    await run(storage.init());
    const asked: string[] = [];
    const store: CacheStore = {
      lookup: (normalizedUrl) => {
        asked.push(normalizedUrl);
        return Effect.succeed({ entry: null } satisfies CacheLookup);
      },
      store: () => Effect.void,
    };
    const seen: string[] = [];
    const crawler = await run(
      createCrawler({
        storage,
        cacheStore: store,
        fetcher: trackingFetcher(seen, () => 200),
        config: {
          maxPages: 1,
          incremental: true,
          concurrency: 1,
          respectRobots: false,
          followRedirects: false,
        },
      }),
    );
    await run(crawler.start("https://cache-seam.test/"));

    // The seam was used, and it was asked per url rather than for a bulk map.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => typeof u === "string")).toBe(true);
    // A store that answers "no entry" costs nothing but the normal fetch.
    expect(seen.length).toBeGreaterThan(0);
    await run(storage.close());
  }, 60_000);

  test("a store that answers from elsewhere turns a 304 into a reused page", async () => {
    const storage = new SQLiteStorage(":memory:");
    await run(storage.init());
    const url = "https://cache-seam.test/";
    // The previous crawl is NOT in this database — only this store can reach it.
    const store: CacheStore = {
      lookup: (normalizedUrl) =>
        Effect.succeed(
          normalizedUrl === url
            ? ({
                entry: priorPage(url),
                freshness: { fresh: false, revalidate: false } as never,
              } satisfies CacheLookup)
            : ({ entry: null } satisfies CacheLookup),
        ),
      store: () => Effect.void,
    };
    const crawler = await run(
      createCrawler({
        storage,
        cacheStore: store,
        fetcher: trackingFetcher([], () => 304),
        config: {
          maxPages: 1,
          incremental: true,
          concurrency: 1,
          respectRobots: false,
          followRedirects: false,
        },
      }),
    );
    const crawlId = await run(crawler.start(url));

    // The page landed in this crawl with the body the store supplied, and it
    // counted as unchanged rather than as a fresh fetch.
    const pages = await run(storage.getPages(crawlId));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.html).toBe(HTML);
    const crawlRow = await run(storage.getCrawl(crawlId));
    expect(crawlRow?.stats.pagesUnchanged).toBe(1);
    expect(crawlRow?.stats.cacheHitsByReason?.["304"]).toBe(1);
    await run(storage.close());
  }, 60_000);

  test("with no store injected the default still reads this database", async () => {
    const storage = new SQLiteStorage(":memory:");
    await run(storage.init());
    const crawler = await run(
      createCrawler({
        storage,
        fetcher: trackingFetcher([], () => 200),
        config: {
          maxPages: 1,
          incremental: true,
          concurrency: 1,
          respectRobots: false,
          followRedirects: false,
        },
      }),
    );
    const crawlId = await run(crawler.start("https://cache-seam.test/"));
    const pages = await run(storage.getPages(crawlId));
    expect(pages).toHaveLength(1);
    await run(storage.close());
  }, 60_000);
});
