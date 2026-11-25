// #2316: the cache's Vary key records the User-Agent the page request sent.
// A custom `User-Agent` header replaces the configured agent on the wire
// (applyBrowserHeaders keeps a header the request already has), so the key
// must hold the header's value, not `[crawler] user_agent`.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import type { CacheStore } from "../src/cache-store";
import type { CrawlerConfig } from "../src/core/types";

import { createCrawler } from "../src/core/crawler";
import {
  applyBrowserHeaders,
  type CrawlFetcher,
  type FetchOptions,
} from "../src/fetcher";
import { SQLiteStorage } from "../src/storage/sqlite";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

const HTML = `<!doctype html><html><head><title>Vary</title></head><body><h1>Vary</h1></body></html>`;

interface Observed {
  /** The User-Agent each page request put on the wire. */
  sent: string[];
  /** The Vary context of each cache lookup. */
  looked: Array<Record<string, string>>;
  /** The Vary context each saved page carries for the next audit. */
  stored: Array<Record<string, string> | null | undefined>;
}

async function crawlOnce(config: Partial<CrawlerConfig>): Promise<Observed> {
  const observed: Observed = { sent: [], looked: [], stored: [] };
  const storage = new SQLiteStorage(":memory:");
  await run(storage.init());
  const cacheStore: CacheStore = {
    lookup: (_url, ctx) => {
      observed.looked.push({ ...ctx.requestHeaders });
      return Effect.succeed({ entry: null });
    },
    store: () => Effect.void,
  };
  const fetcher = ((url: string, options: FetchOptions) => {
    // The same header assembly the real fetcher does before sending.
    const headers = new Headers(options.headers);
    applyBrowserHeaders(headers, options.userAgent);
    observed.sent.push(headers.get("user-agent") ?? "");
    return Effect.succeed({
      url,
      finalUrl: url,
      status: 200,
      loadTime: 1,
      headers: {
        contentType: "text/html",
        contentEncoding: null,
        cacheControl: null,
        vary: "User-Agent",
        etag: null,
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
      contentType: "text/html",
      body: HTML,
      sizeBytes: HTML.length,
      redirectChain: [],
    });
  }) as unknown as CrawlFetcher;
  const crawler = await run(
    createCrawler({
      storage,
      cacheStore,
      fetcher,
      config: {
        maxPages: 1,
        incremental: true,
        concurrency: 1,
        respectRobots: false,
        followRedirects: false,
        disableLinkDiscovery: true,
        perHostDelayMs: 0,
        timeoutMs: 500,
        ...config,
      },
    })
  );
  const crawlId = await run(crawler.start("https://example.com/"));
  for (const page of await run(storage.getPages(crawlId)))
    observed.stored.push(page.requestHeaders);
  await run(storage.close());
  return observed;
}

// Every page request goes through the injected fetcher; nothing reaches the network.
let fetchSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
    return Promise.reject(new Error("network disabled in this test"));
  }) as unknown as typeof fetch);
});
afterAll(() => fetchSpy.mockRestore());

describe("cache Vary key follows the sent User-Agent (#2316)", () => {
  test("a custom User-Agent header (any casing) is the keyed agent over [crawler] user_agent", async () => {
    for (const name of ["User-Agent", "user-agent", "USER-AGENT"]) {
      const observed = await crawlOnce({
        userAgent: "configured-agent",
        headers: { [name]: "custom-agent" },
      });
      expect(observed.sent).toEqual(["custom-agent"]);
      expect(observed.looked.map((c) => c["user-agent"])).toEqual(
        observed.sent
      );
      expect(observed.stored.map((c) => c?.["user-agent"])).toEqual(
        observed.sent
      );
    }
  }, 60_000);

  test("without a custom User-Agent header the configured agent is keyed", async () => {
    const observed = await crawlOnce({
      userAgent: "configured-agent",
      headers: { "X-Other": "1" },
    });
    expect(observed.sent).toEqual(["configured-agent"]);
    expect(observed.looked.map((c) => c["user-agent"])).toEqual(observed.sent);
  }, 60_000);
});
