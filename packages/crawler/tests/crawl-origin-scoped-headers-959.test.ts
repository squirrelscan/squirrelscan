// Custom request headers reach only the audited origin on the crawl's own page
// fetches (#959). Driven through the real crawler with a mock document fetcher,
// asserting both that each URL WAS requested and what headers it carried.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "https://h.invalid";
const TOKEN = { "X-Audit-Token": "secret" };

const PAGE = "<!doctype html><html><head><title>t</title></head><body></body></html>";

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

type Seen = { url: string; token: string | undefined };

function fetcherFor(seen: Seen[]): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      const token = Object.entries(req.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "x-audit-token",
      )?.[1];
      seen.push({ url: req.url, token });
      return mockResponse(req.url, PAGE);
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
  incremental: false,
  useCacheControl: false,
  maxPages: 50,
  headers: TOKEN,
};

async function crawlUrls(
  urls: string[],
  extra: Record<string, unknown> = {},
  crawl: { baseUrl?: string; originalUrl?: string } = {},
): Promise<Seen[]> {
  const storage: CrawlStorage = await Effect.runPromise(createTestStorage());
  const config = { ...baseConfig, ...extra };
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: crawl.baseUrl ?? ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: crawl.originalUrl ?? `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config,
      stats: emptyStats,
    }),
  );
  for (const [index, url] of urls.entries()) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: url,
        rawUrl: url,
        depth: index === 0 ? 0 : 1,
        priority: 1,
        status: "pending" as const,
        source: index === 0 ? ("seed" as const) : ("sitemap" as const),
        enqueuedAt: Date.now(),
        retryCount: 0,
      }),
    );
  }
  const seen: Seen[] = [];
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...config, documentFetcher: fetcherFor(seen) }, storage }),
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  return seen;
}

/** The token a URL carried; fails the test if the URL was never requested. */
function tokenOf(seen: Seen[], url: string): string | undefined {
  const hit = seen.find((s) => s.url === url);
  expect(hit).toBeDefined();
  return hit?.token;
}

describe("the crawl sends custom headers only to the audited origin (#959)", () => {
  test("the audited origin keeps them", async () => {
    const seen = await crawlUrls([`${ORIGIN}/`, `${ORIGIN}/a`]);
    expect(tokenOf(seen, `${ORIGIN}/`)).toBe("secret");
    expect(tokenOf(seen, `${ORIGIN}/a`)).toBe("secret");
  });

  test("an explicit default port is still the audited origin", async () => {
    const seen = await crawlUrls([`${ORIGIN}/`, `${ORIGIN}:443/a`]);
    expect(seen.some((s) => s.token === "secret" && s.url.endsWith("/a"))).toBe(true);
  });

  test("an http: page on the audited host is crawled without them", async () => {
    const seen = await crawlUrls([`${ORIGIN}/`, "http://h.invalid/plain"]);
    expect(tokenOf(seen, `${ORIGIN}/`)).toBe("secret");
    expect(tokenOf(seen, "http://h.invalid/plain")).toBeUndefined();
  });

  test("another port on the audited host is crawled without them", async () => {
    const seen = await crawlUrls([`${ORIGIN}/`, `${ORIGIN}:8443/p`]);
    expect(tokenOf(seen, `${ORIGIN}:8443/p`)).toBeUndefined();
  });

  test("a host that allowedDomains admits gets none unless header_hosts names it", async () => {
    const allowed = { allowedDomains: ["h.invalid", "other.invalid"] };
    const without = await crawlUrls([`${ORIGIN}/`, "https://other.invalid/o"], allowed);
    expect(tokenOf(without, `${ORIGIN}/`)).toBe("secret");
    expect(tokenOf(without, "https://other.invalid/o")).toBeUndefined();

    const named = await crawlUrls([`${ORIGIN}/`, "https://other.invalid/o"], {
      ...allowed,
      headerHosts: ["other.invalid"],
    });
    expect(tokenOf(named, "https://other.invalid/o")).toBe("secret");
  });

  test("a host an absolute include pattern admits gets none", async () => {
    const seen = await crawlUrls([`${ORIGIN}/`, "https://cdn.invalid/x"], {
      include: ["https://cdn.invalid/*", `${ORIGIN}/*`],
    });
    expect(tokenOf(seen, "https://cdn.invalid/x")).toBeUndefined();
  });
});

describe("custom headers are never sent over http on the strength of a redirect (#959)", () => {
  test("an https start URL whose redirect landed on http: keeps its https scope", async () => {
    const seen = await crawlUrls(
      ["http://h.invalid/", "http://h.invalid/a", `${ORIGIN}/b`],
      {},
      { baseUrl: "http://h.invalid", originalUrl: `${ORIGIN}/` },
    );
    expect(tokenOf(seen, "http://h.invalid/")).toBeUndefined();
    expect(tokenOf(seen, "http://h.invalid/a")).toBeUndefined();
    expect(tokenOf(seen, `${ORIGIN}/b`)).toBe("secret");
  });

  test("an http start URL audits over http, with the headers", async () => {
    const seen = await crawlUrls(
      ["http://h.invalid/", "http://h.invalid/a"],
      {},
      { baseUrl: "http://h.invalid", originalUrl: "http://h.invalid/" },
    );
    expect(tokenOf(seen, "http://h.invalid/a")).toBe("secret");
  });

  test("a named header host gets them over https only, unless written with http://", async () => {
    const allowed = { allowedDomains: ["h.invalid", "other.invalid"] };
    const urls = [`${ORIGIN}/`, "http://other.invalid/p", "https://other.invalid/s"];
    const bare = await crawlUrls(urls, { ...allowed, headerHosts: ["other.invalid"] });
    expect(tokenOf(bare, "http://other.invalid/p")).toBeUndefined();
    expect(tokenOf(bare, "https://other.invalid/s")).toBe("secret");
    const explicit = await crawlUrls(urls, { ...allowed, headerHosts: ["http://other.invalid"] });
    expect(tokenOf(explicit, "http://other.invalid/p")).toBe("secret");
  });
});
