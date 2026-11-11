// #1762: the crawler and the engine read the same rows as redirects. `getPageCount` mirrors the engine's marker
// (`isRedirectRecord`), so a crawl whose only 3xx rows looped or ended in an error is not "no pages collected";
// the shared predicate leaves a redirect kept on purpose (`keptAsPage`) a page; and a cached legacy 2xx row the
// engine drops takes no page slot and queues its destination.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { PageRecord } from "@squirrelscan/core-contracts/storage";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { isRedirectSourcePage } from "../src/redirect-row";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";

function html(...links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

const SITE: Record<string, string> = {
  [`${ORIGIN}/`]: html(),
};

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps every stored page fresh on pass 2, so it is reused unfetched.
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

async function createCrawlRecord(
  storage: CrawlStorage,
  config: Record<string, unknown>,
): Promise<string> {
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

async function seedFrontier(
  storage: CrawlStorage,
  crawlId: string,
  entries: Array<{ path: string; source: "seed" | "sitemap" }>,
) {
  for (const { path, source } of entries) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: `${ORIGIN}${path}`,
        rawUrl: `${ORIGIN}${path}`,
        depth: source === "seed" ? 0 : 1,
        priority: 1,
        status: "pending" as const,
        source,
        enqueuedAt: Date.now(),
        retryCount: 0,
      }),
    );
  }
}


function row(url: string, over: Partial<PageRecord>): PageRecord {
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 0,
    loadTimeMs: 1,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "",
    html: null,
    parsedData: null,
    headers: {
      contentType: "text/html",
      contentEncoding: null,
      cacheControl: "max-age=3600",
      vary: null,
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
    ...over,
  } as PageRecord;
}

function chain(from: string, to: string, over: Partial<NonNullable<PageRecord["redirectChain"]>> = {}) {
  return {
    sourceUrl: from,
    finalUrl: to,
    hops: [
      { url: from, statusCode: 301, type: "http" as const },
      { url: to, statusCode: 200, type: "http" as const },
    ],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
    ...over,
  };
}

const U = (path: string) => `${ORIGIN}${path}`;

describe("getPageCount mirrors the engine's redirect marker (#1762)", () => {
  test("a resolved 3xx is a redirect; a loop, an error chain, a one-hop 3xx and a 3xx to itself are pages", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await createCrawlRecord(storage, { ...baseConfig });
    const rows: PageRecord[] = [
      row(U("/page"), { html: "<p>x</p>" }),
      row(U("/marker"), { status: 301, finalUrl: U("/dest"), redirectChain: chain(U("/marker"), U("/dest")) }),
      row(U("/loop"), {
        status: 301,
        finalUrl: U("/loop-b"),
        redirectChain: chain(U("/loop"), U("/loop-b"), { isLoop: true }),
      }),
      row(U("/err"), {
        status: 301,
        finalUrl: U("/nowhere"),
        redirectChain: chain(U("/err"), U("/nowhere"), { endsInError: true }),
      }),
      row(U("/one-hop"), {
        status: 301,
        finalUrl: U("/dest"),
        redirectChain: { ...chain(U("/one-hop"), U("/dest")), hops: [{ url: U("/one-hop"), statusCode: 301, type: "http" as const }] },
      }),
      row(U("/no-chain"), { status: 301, finalUrl: U("/dest") }),
      row(U("/same"), { status: 302, finalUrl: U("/same"), redirectChain: chain(U("/same"), U("/same")) }),
    ];
    for (const r of rows) await Effect.runPromise(storage.upsertPage(crawlId, r));
    const count = await Effect.runPromise(storage.getPageCount(crawlId));
    // The same rows through the engine's predicate: only /marker is a redirect.
    expect(rows.filter((r) => isRedirectSourcePage(r)).map((r) => r.normalizedUrl)).toEqual([U("/marker")]);
    expect(count).toBe(rows.length - 1);
    await Effect.runPromise(storage.close());
  });

  test("a loop-only crawl is not an empty one", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const crawlId = await createCrawlRecord(storage, { ...baseConfig });
    await Effect.runPromise(
      storage.upsertPage(
        crawlId,
        row(U("/loop"), {
          status: 301,
          finalUrl: U("/loop-b"),
          redirectChain: chain(U("/loop"), U("/loop-b"), { isLoop: true }),
        }),
      ),
    );
    expect(await Effect.runPromise(storage.getPageCount(crawlId))).toBe(1);
    await Effect.runPromise(storage.close());
  });
});

describe("a redirect the crawler kept as a page is not a legacy redirect (#1762)", () => {
  const legacy = row(U("/docs/"), {
    html: "<p>x</p>",
    finalUrl: U("/documentation/"),
    redirectChain: chain(U("/docs/"), U("/documentation/")),
  });

  test("an unmarked 2xx row holding another URL's markup is a legacy redirect", () => {
    expect(isRedirectSourcePage(legacy)).toBe(true);
  });

  test("the same row marked keptAsPage stays a page", () => {
    expect(
      isRedirectSourcePage({ ...legacy, redirectChain: { ...legacy.redirectChain!, keptAsPage: true } }),
    ).toBe(false);
  });
});

describe("a cached legacy redirect row is a redirect for the crawl too (#1762)", () => {
  test("it takes no page slot and its destination is queued", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
    const crawlId1 = await createCrawlRecord(storage, cfg1);
    await seedFrontier(storage, crawlId1, [{ path: "/", source: "seed" }]);
    const crawler1 = await Effect.runPromise(
      createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([]) }, storage }),
    );
    await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
    // An older crawl's row: the destination's markup filed under the redirecting URL, still fresh.
    const [home] = await Effect.runPromise(storage.getPages(crawlId1));
    await Effect.runPromise(
      storage.upsertPage(crawlId1, {
        ...home!,
        url: U("/legacy"),
        normalizedUrl: U("/legacy"),
        finalUrl: U("/dest"),
        redirectChain: chain(U("/legacy"), U("/dest")),
      }),
    );

    const fetched: string[] = [];
    const cfg2 = { ...baseConfig, incremental: true, useCacheControl: true, maxStalenessSeconds: 999_999 };
    const crawlId2 = await createCrawlRecord(storage, cfg2);
    await seedFrontier(storage, crawlId2, [
      { path: "/", source: "seed" },
      { path: "/legacy", source: "sitemap" },
    ]);
    const crawler2 = await Effect.runPromise(
      createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched) }, storage }),
    );
    await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));

    const frontier = (await Effect.runPromise(storage.getAllFrontierEntries(crawlId2))).map((e) => e.normalizedUrl);
    // The destination is crawled once, from the legacy row's redirect.
    expect(frontier).toContain(U("/dest"));
    expect(fetched).toContain(U("/dest"));
    await Effect.runPromise(storage.close());
  }, 30000);
});
