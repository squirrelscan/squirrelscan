// #2127: a quick crawl whose sitemap is larger than maxPages still fetches the start URL. Driven through the REAL crawler.start() with the
// injectable page fetcher; globalThis.fetch is stubbed (robots.txt answers, everything else 404) so any
// request the crawl makes outside the fetcher is recorded and can be asserted absent.

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

function chain(url: string, finalUrl: string): RedirectChain {
  const redirected = finalUrl !== url;
  return {
    sourceUrl: url,
    finalUrl,
    hops: redirected ? [{ url, statusCode: 301, type: "http" }] : [],
    chainLength: redirected ? 1 : 0,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

/** Pages by absolute URL; a `redirectTo` answers 301 with that destination as the final URL. */
type Site = Record<string, { body?: string; redirectTo?: string }>;

function buildFetcher(site: Site, fetched: string[]): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      fetched.push(url);
      const page = site[url];
      const status = page ? 200 : 404;
      const body = page?.body ?? "";
      yield* applyStatusGuards(url, status, new Headers(), body);
      const finalUrl = page?.redirectTo ?? url;
      const destinationBody = page?.redirectTo ? (site[page.redirectTo]?.body ?? "") : body;
      return {
        url,
        finalUrl,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html", setCookie: null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType: "text/html",
        body: destinationBody,
        sizeBytes: destinationBody.length,
        redirectChain: chain(url, finalUrl),
      };
    });
}

const page = (...paths: string[]): string =>
  `<!doctype html><html><body>${paths.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("")}</body></html>`;

/** A 20 page site: / links to /p/1 .. /p/19, and /redir redirects to /p/5. */
function bigSite(): Site {
  const site: Site = { [`${ORIGIN}/`]: { body: page(...Array.from({ length: 19 }, (_, i) => `/p/${i + 1}`)) } };
  for (let i = 1; i <= 19; i++) site[`${ORIGIN}/p/${i}`] = { body: page("/p/1", "/p/2") };
  site[`${ORIGIN}/redir`] = { redirectTo: `${ORIGIN}/p/5` };
  site[`${ORIGIN}/redir-away`] = { redirectTo: `${ORIGIN}/p/6` };
  return site;
}

const BASE_CONFIG: Partial<CrawlerConfig> = {
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 1000,
  userAgent: "test",
  respectRobots: true,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: true,
  coverageMode: "quick",
  maxPages: 100,
};

const ROBOTS = `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`;

interface Result {
  /** URLs the page fetcher was asked for. */
  fetched: string[];
  /** Every URL requested through global fetch (robots.txt, sitemaps, probes). */
  other: string[];
  frontier: Array<{ url: string; status: string; reason?: string; parent?: string }>;
  stats: Record<string, unknown>;
}

async function run(config: Partial<CrawlerConfig>, site: Site, other: string[]): Promise<Result> {
  const fetched: string[] = [];
  const fetcher = buildFetcher(site, fetched);
  return Effect.runPromise(
    Effect.gen(function* () {
      const crawler = yield* createCrawler({ fetcher, config: { ...BASE_CONFIG, ...config } });
      const crawlId = yield* crawler.start(ORIGIN);
      const entries = yield* crawler.storage.getAllFrontierEntries(crawlId);
      const crawl = yield* crawler.storage.getCrawl(crawlId);
      return {
        fetched,
        other,
        frontier: entries.map((e) => ({
          url: e.normalizedUrl,
          status: e.status,
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.parentUrl ? { parent: e.parentUrl } : {}),
        })),
        stats: (crawl?.stats ?? {}) as Record<string, unknown>,
      };
    }),
  );
}


const MAX_PAGES = 10;
const SITEMAP_SIZE = 40;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/</loc><priority>0.1</priority></url>${Array.from(
  { length: SITEMAP_SIZE },
  (_, i) => `<url><loc>${ORIGIN}/p/${i + 1}</loc><priority>1.0</priority></url>`,
).join("")}</urlset>`;

function sitemapSite(): Site {
  const site: Site = { [`${ORIGIN}/`]: { body: page() } };
  for (let i = 1; i <= SITEMAP_SIZE; i++) site[`${ORIGIN}/p/${i}`] = { body: page() };
  return site;
}

describe("quick crawl start URL under a large sitemap (#2127)", () => {
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
      const body =
        url === `${ORIGIN}/robots.txt` ? ROBOTS : url === `${ORIGIN}/sitemap.xml` ? SITEMAP_XML : "";
      const ok = body !== "";
      const res = new Response(body, {
        status: ok ? 200 : 404,
        headers: { "content-type": url.endsWith(".xml") ? "application/xml" : "text/plain" },
      });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("the start URL is fetched first and counts toward maxPages", async () => {
    const r = await run({ maxPages: MAX_PAGES }, sitemapSite(), []);
    expect(r.fetched).toContain(`${ORIGIN}/`);
    expect(r.fetched[0]).toBe(`${ORIGIN}/`);
    expect(r.fetched).toHaveLength(MAX_PAGES);
    expect(r.stats.linkDiscoveryOff).toBe(true);
  });
});
