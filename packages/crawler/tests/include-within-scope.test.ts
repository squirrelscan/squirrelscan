// #347 — a path-only include pattern narrows within the crawl's host scope; it
// does not replace it. An absolute-URL pattern names its host and stays the
// explicit way to reach another one. Covers isInScope directly and through the
// real crawler.start(). Links parsed off a page are already limited to the
// page's own hostname, so a third-party URL reaches the scope check through the
// sitemap (a `<loc>` on another host), which is how the crawl test feeds it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig } from "../src/core/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import { isInScope } from "../src/frontier";
import type { RedirectChain, ResponseHeaders, SecurityHeaders } from "../src/storage/types";

const ORIGIN = "https://example.com";
const THIRD = "https://third.example.net";

describe("isInScope: include narrows within host scope (#347)", () => {
  const base = { baseUrl: ORIGIN, exclude: [] as string[] };

  test("a path-only include does not admit a third-party host", () => {
    const d = isInScope(`${THIRD}/blog/post`, { ...base, include: ["/blog/*"] });
    expect(d).toEqual({ allowed: false, reason: "cross_domain" });
  });

  test("`/*` no longer means follow every link anywhere", () => {
    expect(isInScope(`${THIRD}/anything`, { ...base, include: ["/*"] }).allowed).toBe(false);
  });

  test("negative control: the same path on the base host is admitted", () => {
    expect(isInScope(`${ORIGIN}/blog/post`, { ...base, include: ["/blog/*"] }).allowed).toBe(true);
  });

  test("a path outside the include list is still not_included", () => {
    const d = isInScope(`${ORIGIN}/about`, { ...base, include: ["/blog/*"] });
    expect(d).toEqual({ allowed: false, reason: "not_included" });
  });

  test("the www host of an apex base stays in scope under a path-only include", () => {
    const d = isInScope("https://www.example.com/blog/a", { ...base, include: ["/blog/*"] });
    expect(d.allowed).toBe(true);
  });

  test("an absolute-URL include still reaches the host it names", () => {
    const d = isInScope(`${THIRD}/docs/a`, { ...base, include: [`${THIRD}/docs/*`] });
    expect(d.allowed).toBe(true);
  });

  test("an absolute-URL include admits only what it matches", () => {
    const d = isInScope(`${THIRD}/other`, { ...base, include: [`${THIRD}/docs/*`] });
    expect(d).toEqual({ allowed: false, reason: "not_included" });
  });

  test("allowedDomains is honoured alongside a path-only include", () => {
    const opts = { ...base, include: ["/blog/*"], allowedDomains: ["example.net"] };
    // Inside allowedDomains and matching the include: admitted.
    expect(isInScope(`${THIRD}/blog/post`, opts).allowed).toBe(true);
    // Matching the include but outside allowedDomains: refused.
    const d = isInScope("https://elsewhere.test/blog/post", opts);
    expect(d).toEqual({ allowed: false, reason: "cross_domain" });
    // Inside allowedDomains but outside the include: still narrowed.
    expect(isInScope(`${THIRD}/about`, opts)).toEqual({ allowed: false, reason: "not_included" });
  });

  test("exclude still wins over include", () => {
    const d = isInScope(`${ORIGIN}/blog/private/x`, {
      ...base,
      include: ["/blog/*"],
      exclude: ["/blog/private/*"],
    });
    expect(d).toEqual({ allowed: false, reason: "excluded" });
  });
});

// ---- Through the real crawler: a discovered third-party link ----

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

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/blog/own</loc></url>
  <url><loc>${THIRD}/blog/theirs</loc></url>
</urlset>`;

const SITE: Record<string, string> = {
  [`${ORIGIN}/`]: "<!doctype html><html><body>home</body></html>",
  [`${ORIGIN}/blog/own`]: "<!doctype html><html><body>own</body></html>",
  [`${THIRD}/blog/theirs`]: "<!doctype html><html><body>theirs</body></html>",
};

function buildFetcher(fetched: string[]): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      fetched.push(url);
      const body = SITE[url] ?? "";
      const status = url in SITE ? 200 : 404;
      yield* applyStatusGuards(url, status, new Headers(), body);
      return {
        url,
        finalUrl: url,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html", setCookie: null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType: "text/html",
        body,
        sizeBytes: body.length,
        redirectChain: noRedirectChain(url),
      };
    });
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

async function runCrawl(config: Partial<CrawlerConfig>): Promise<string[]> {
  const fetched: string[] = [];
  const fetcher = buildFetcher(fetched);
  await Effect.runPromise(
    Effect.gen(function* () {
      const crawler = yield* createCrawler({ fetcher, config: { ...BASE_CONFIG, ...config } });
      yield* crawler.start(ORIGIN);
    }),
  );
  return fetched;
}

describe("crawl with a path-only include (#347)", () => {
  let originalFetch: typeof globalThis.fetch;

  // Keep the pre-crawl preamble (redirect, robots, sitemap probing) offline:
  // everything 404s except the sitemap, which lists a third-party URL.
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const res =
        url === `${ORIGIN}/sitemap.xml`
          ? new Response(SITEMAP, { status: 200, headers: { "content-type": "application/xml" } })
          : new Response("", { status: 404, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a third-party URL whose path matches the include is never fetched", async () => {
    const fetched = await runCrawl({ include: ["/blog/*", "/"] });
    expect(fetched).toContain(`${ORIGIN}/blog/own`);
    expect(fetched).not.toContain(`${THIRD}/blog/theirs`);
  });

  test("negative control: with no include the third-party link is out of scope too", async () => {
    const fetched = await runCrawl({ include: [] });
    expect(fetched).toContain(`${ORIGIN}/blog/own`);
    expect(fetched).not.toContain(`${THIRD}/blog/theirs`);
  });

  test("an absolute-URL include still reaches the third-party host it names", async () => {
    const fetched = await runCrawl({ include: ["/", "/blog/*", `${THIRD}/blog/*`] });
    expect(fetched).toContain(`${THIRD}/blog/theirs`);
  });

  test("allowedDomains admits the third-party host under the same include", async () => {
    const fetched = await runCrawl({
      include: ["/", "/blog/*"],
      allowedDomains: ["example.com", "example.net"],
    });
    expect(fetched).toContain(`${THIRD}/blog/theirs`);
  });
});
