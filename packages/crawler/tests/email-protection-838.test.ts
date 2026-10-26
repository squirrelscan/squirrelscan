// pub#838: Cloudflare's `/cdn-cgi/l/email-protection` link is a mailto in the browser,
// never a page, so the crawl must never queue it or fetch it. Two paths queue links:
// a page fetched this run (links come from the HTML) and a page reused from the cache
// (links come from the parsedData stored when it was last fetched). A page cached before
// the fix still lists the path as an internal link, so the reuse path filters it too.
// Driven through the real crawler with a mock document fetcher, as #354's test is.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";
const OBFUSCATION = "/cdn-cgi/l/email-protection";

function html(...links: string[]): string {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

const SITE: Record<string, string> = {
  [`${ORIGIN}/`]: html("/listed", `${OBFUSCATION}#2a4f`, `${ORIGIN}${OBFUSCATION}`, "/cdn-cgi/image/width=80/pic.jpg"),
  [`${ORIGIN}/listed`]: html(),
};

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
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

async function createCrawlRecord(storage: CrawlStorage, config: Record<string, unknown>): Promise<string> {
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

async function seedFrontier(storage: CrawlStorage, crawlId: string, paths: string[]) {
  for (const [index, path] of paths.entries()) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: `${ORIGIN}${path}`,
        rawUrl: `${ORIGIN}${path}`,
        depth: index === 0 ? 0 : 1,
        priority: 1,
        status: "pending" as const,
        source: index === 0 ? ("seed" as const) : ("sitemap" as const),
        enqueuedAt: Date.now(),
        retryCount: 0,
      }),
    );
  }
}

async function crawlOnce(storage: CrawlStorage, config: Record<string, unknown>, fetched: string[], paths: string[]) {
  const crawlId = await createCrawlRecord(storage, config);
  await seedFrontier(storage, crawlId, paths);
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...config, documentFetcher: fetcherFor(fetched) }, storage }),
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  return crawlId;
}

describe("the crawl never queues Cloudflare's email obfuscation link (pub#838)", () => {
  test("a page fetched this run: the path is not fetched, stored as a link, or in the frontier", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const fetched: string[] = [];
    const crawlId = await crawlOnce(
      storage,
      { ...baseConfig, incremental: false, useCacheControl: false },
      fetched,
      ["/"],
    );

    // Sanity: the crawl followed an ordinary link from the same page.
    expect(fetched).toContain(`${ORIGIN}/listed`);
    expect(fetched.some((u) => u.includes("email-protection"))).toBe(false);
    // An image-resizing path is not the obfuscation path and is still queued.
    expect(fetched).toContain(`${ORIGIN}/cdn-cgi/image/width=80/pic.jpg`);

    const frontier = await Effect.runPromise(storage.getAllFrontierEntries(crawlId));
    expect(frontier.some((e) => e.normalizedUrl.includes("email-protection"))).toBe(false);
    const home = await Effect.runPromise(storage.getPage(crawlId, `${ORIGIN}/`));
    const stored = JSON.parse(home!.parsedData!) as { links: Array<{ url: string }> };
    expect(stored.links.some((l) => l.url.includes("email-protection"))).toBe(false);
    await Effect.runPromise(storage.close());
  }, 30000);

  test("a page reused from a cache written before the fix: the stale link is not queued", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const pass1 = await crawlOnce(storage, { ...baseConfig, incremental: false, useCacheControl: false }, [], ["/"]);

    // Make the stored page look like one cached by an older squirrel: the obfuscation path
    // is an internal link in its parsedData. `/off-map` is the control: it must be queued,
    // which proves the rewrite reached the reuse path.
    const home = await Effect.runPromise(storage.getPage(pass1, `${ORIGIN}/`));
    const parsed = JSON.parse(home!.parsedData!) as { links: Array<Record<string, unknown>> };
    parsed.links.push(
      { url: `${ORIGIN}${OBFUSCATION}`, text: "[email protected]", isInternal: true },
      { url: `${ORIGIN}${OBFUSCATION}#2a4f`, text: "[email protected]", isInternal: true },
      { url: `${ORIGIN}/off-map`, text: "control", isInternal: true },
    );
    await Effect.runPromise(storage.upsertPage(pass1, { ...home!, parsedData: JSON.stringify(parsed) }));

    const fetched: string[] = [];
    const pass2 = await crawlOnce(
      storage,
      { ...baseConfig, incremental: true, useCacheControl: true, maxStalenessSeconds: 999_999 },
      fetched,
      ["/", "/listed"],
    );

    // Nothing is re-fetched, and the one link the crawl follows is the control.
    expect(fetched).toEqual([`${ORIGIN}/off-map`]);
    const frontier = (await Effect.runPromise(storage.getAllFrontierEntries(pass2))).map((e) => e.normalizedUrl);
    expect(frontier).toContain(`${ORIGIN}/off-map`);
    expect(frontier.some((u) => u.includes("email-protection"))).toBe(false);
    await Effect.runPromise(storage.close());
  }, 30000);
});
