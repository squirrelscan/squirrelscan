// #1146 — carried-finding crawl seeding + dead-URL de-prioritization, driven
// through the REAL crawler.start() (not re-derived priorities). The page fetch
// is the injectable `fetcher` seam; globalThis.fetch is stubbed to 404 so the
// pre-crawl preamble (redirect/robots/sitemap probing) stays offline. This
// exercises the actual start() seed loop + enqueueUrl "carried" branch +
// recently-removed penalty in packages/crawler/src/core/crawler.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import type { RedirectChain, ResponseHeaders, SecurityHeaders } from "../src/storage/types";

const ORIGIN = "https://example.com";

const EMPTY_RESPONSE_HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  expires: null,
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
};

const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function noRedirectChain(url: string): RedirectChain {
  return {
    sourceUrl: url,
    finalUrl: url,
    hops: [],
    chainLength: 0,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

type Site = Record<string, { body: string; status?: number }>;

function buildFetcher(site: Site, fetched: string[]): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      fetched.push(url);
      const page = site[url];
      const status = page?.status ?? (page ? 200 : 404);
      const body = page?.body ?? "";
      yield* applyStatusGuards(url, status, new Headers(), body);
      const contentType = page === undefined ? "text/plain" : "text/html";
      return {
        url,
        finalUrl: url,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType, setCookie: null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType,
        body,
        sizeBytes: body.length,
        redirectChain: noRedirectChain(url),
      };
    });
}

function html(...paths: string[]): string {
  const anchors = paths.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><body>${anchors}</body></html>`;
}

const BASE_CONFIG: Partial<CrawlerConfig> = {
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 1000,
  userAgent: "test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: false,
  coverageMode: "full",
};

async function runCrawl(config: Partial<CrawlerConfig>, site: Site): Promise<string[]> {
  const fetched: string[] = [];
  const fetcher = buildFetcher(site, fetched);
  await Effect.runPromise(
    Effect.gen(function* () {
      const crawler = yield* createCrawler({ fetcher, config: { ...BASE_CONFIG, ...config } });
      yield* crawler.start(ORIGIN);
    }),
  );
  return fetched;
}

describe("carried-finding crawl seeding (#1146)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const res = new Response("", { status: 404, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("seeds orphaned carried pages and de-prioritizes dead URLs within budget", async () => {
    // Homepage links 2 live + 3 known-dead pages. The carried pages are ORPHANS
    // (not linked anywhere), so only frontier seeding pulls them in. /dead-* are
    // intentionally unmapped in the site fixture → the fetcher 404s them.
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/live-a", "/live-b", "/dead-1", "/dead-2", "/dead-3") },
      [`${ORIGIN}/live-a`]: { body: html() },
      [`${ORIGIN}/live-b`]: { body: html() },
      [`${ORIGIN}/carried-x`]: { body: html() },
      [`${ORIGIN}/carried-y`]: { body: html() },
    };

    const fetched = await runCrawl(
      {
        maxPages: 5,
        carriedSeedUrls: [`${ORIGIN}/carried-x`, `${ORIGIN}/carried-y`],
        deprioritizedUrls: [`${ORIGIN}/dead-1`, `${ORIGIN}/dead-2`, `${ORIGIN}/dead-3`],
      },
      site,
    );

    // Both orphaned carried pages were re-crawled despite never being linked.
    expect(fetched).toContain(`${ORIGIN}/carried-x`);
    expect(fetched).toContain(`${ORIGIN}/carried-y`);
    // Budget went to live pages; de-prioritized dead URLs never ate a slot.
    expect(fetched).not.toContain(`${ORIGIN}/dead-1`);
    expect(fetched).not.toContain(`${ORIGIN}/dead-2`);
    expect(fetched).not.toContain(`${ORIGIN}/dead-3`);
    expect(fetched.length).toBeLessThanOrEqual(5);
  });

  test("no seeding config → orphaned pages stay un-crawled (today's behavior)", async () => {
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/live-a", "/live-b") },
      [`${ORIGIN}/live-a`]: { body: html() },
      [`${ORIGIN}/live-b`]: { body: html() },
      [`${ORIGIN}/orphan`]: { body: html() },
    };

    const fetched = await runCrawl({ maxPages: 100 }, site);

    // Under budget: every linked page crawled, the orphan is not reached.
    expect(fetched.sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/live-a`, `${ORIGIN}/live-b`]);
    expect(fetched).not.toContain(`${ORIGIN}/orphan`);
  });
});
