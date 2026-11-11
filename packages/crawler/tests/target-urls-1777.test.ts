// #1777: `targetUrls` audits exactly the given URLs. Driven through the REAL crawler.start() with the
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
  disableLinkDiscovery: false,
  coverageMode: "full",
  maxPages: 100,
};

const ROBOTS = `User-agent: *\nDisallow: /private\nSitemap: ${ORIGIN}/sitemap.xml\n`;

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

describe("targetUrls (#1777)", () => {
  let originalFetch: typeof globalThis.fetch;
  let other: string[] = [];

  beforeEach(() => {
    other = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      other.push(url);
      const isRobots = url === `${ORIGIN}/robots.txt`;
      const res = new Response(isRobots ? ROBOTS : "", {
        status: isRobots ? 200 : 404,
        headers: { "content-type": "text/plain" },
      });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches exactly 3 of 20 pages, follows no link and reads no sitemap or probe", async () => {
    const r = await run(
      { targetUrls: [`${ORIGIN}/p/1`, `${ORIGIN}/p/2`, `${ORIGIN}/p/3`] },
      bigSite(),
      other,
    );
    expect(r.fetched.sort()).toEqual([`${ORIGIN}/p/1`, `${ORIGIN}/p/2`, `${ORIGIN}/p/3`]);
    // Outside the pages the crawl asks for robots.txt (honoured) and nothing else: not the start URL, no
    // sitemap, no discovery probe (llms.txt, well-known, ...).
    expect(other).toEqual([`${ORIGIN}/robots.txt`]);
    expect(r.stats.targetedRun).toBe(true);
    expect(r.stats.linkDiscoveryOff).toBe(true);
    // The frontier holds the targets and nothing the pages linked to.
    expect(r.frontier.map((f) => f.url).sort()).toEqual([
      `${ORIGIN}/p/1`,
      `${ORIGIN}/p/2`,
      `${ORIGIN}/p/3`,
    ]);
  });

  test("a relative target resolves against the site; a duplicate is one", async () => {
    const r = await run({ targetUrls: ["/p/1", `${ORIGIN}/p/1`, "/p/1/"] }, bigSite(), other);
    expect(r.fetched).toContain(`${ORIGIN}/p/1`);
    expect(new Set(r.fetched).size).toBe(r.fetched.length);
  });

  test("a refused URL is kept with its reason, never dropped", async () => {
    const site = { ...bigSite(), [`${ORIGIN}/private/x`]: { body: page() } };
    const r = await run(
      {
        targetUrls: [
          `${ORIGIN}/p/1`,
          `${ORIGIN}/private/x`,
          "https://other.example.org/page",
          "http://[bad",
        ],
      },
      site,
      other,
    );
    expect(r.fetched).toEqual([`${ORIGIN}/p/1`]);
    const reasons = Object.fromEntries(r.frontier.filter((f) => f.status === "skipped").map((f) => [f.url, f.reason]));
    expect(reasons[`${ORIGIN}/private/x`]).toBe("robots_disallowed");
    expect(Object.values(reasons)).toContain("invalid_url");
    // The off-site URL carries the scope reason.
    expect(reasons["https://other.example.org/page"]).toBeDefined();
  });

  test("maxPages caps the list and the rest is listed as over_max_pages", async () => {
    const targets = [1, 2, 3, 4, 5].map((i) => `${ORIGIN}/p/${i}`);
    const r = await run({ targetUrls: targets, maxPages: 2 }, bigSite(), other);
    expect(r.fetched).toEqual([`${ORIGIN}/p/1`, `${ORIGIN}/p/2`]);
    const over = r.frontier.filter((f) => f.reason === "over_max_pages").map((f) => f.url);
    expect(over.sort()).toEqual([`${ORIGIN}/p/3`, `${ORIGIN}/p/4`, `${ORIGIN}/p/5`]);
  });

  test("a redirecting target is a redirect; its destination is audited only when it is listed too", async () => {
    // /redir -> /p/5 (also listed): both fetched, /p/5 once. /redir-away -> /p/6 (not listed): not followed.
    const r = await run(
      { targetUrls: [`${ORIGIN}/redir`, `${ORIGIN}/p/5`, `${ORIGIN}/redir-away`] },
      bigSite(),
      other,
    );
    expect(r.fetched.sort()).toEqual([`${ORIGIN}/p/5`, `${ORIGIN}/redir`, `${ORIGIN}/redir-away`]);
    expect(r.fetched).not.toContain(`${ORIGIN}/p/6`);
    const skipped = r.frontier.find((f) => f.reason === "redirect_not_targeted");
    expect(skipped).toMatchObject({ url: `${ORIGIN}/p/6`, parent: `${ORIGIN}/redir-away` });
  });

  test("without targetUrls the same crawl follows links and reads the sitemap as ever", async () => {
    const r = await run({}, bigSite(), other);
    expect(r.fetched.length).toBeGreaterThan(10);
    expect(other).toContain(`${ORIGIN}/sitemap.xml`);
    expect(r.stats.targetedRun).toBeUndefined();
  });
});
