// #1229 — the publish schema rejects any pages[].url (and other crawled-URL
// join keys) past REPORT_LIMITS.maxUrlLength STRICT, no clamp. A page linking
// to an oversize same-site URL that got crawled successfully used to fail the
// whole publish. The frontier must refuse (skip, not truncate) URLs past the
// cap before they're ever fetched. Driven through the real crawler.start(),
// same harness shape as carried-seed-crawl.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

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

function html(...urls: string[]): string {
  const anchors = urls.map((u) => `<a href="${u}">${u}</a>`).join("");
  return `<!doctype html><html><body>${anchors}</body></html>`;
}

const BASE_CONFIG: Partial<CrawlerConfig> = {
  maxPages: 10,
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

describe("frontier URL length cap (#1229)", () => {
  let originalFetch: typeof globalThis.fetch;

  // The pre-crawl preamble (redirect detection, robots.txt, sitemap probing)
  // hits globalThis.fetch directly, not the injectable CrawlFetcher — stub it
  // to a fast 404 so the test stays offline (same as carried-seed-crawl.test.ts).
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

  test("oversize same-site href is skipped, never crawled, and recorded in the frontier", async () => {
    // A same-site path long enough that the full URL clears maxUrlLength
    // (2048) — a pathological session-id/query monster, not a real resource.
    const oversizePath = `/p?x=${"a".repeat(REPORT_LIMITS.maxUrlLength)}`;
    const oversizeUrl = `${ORIGIN}${oversizePath}`;
    expect(oversizeUrl.length).toBeGreaterThan(REPORT_LIMITS.maxUrlLength);

    const site: Site = {
      [`${ORIGIN}/`]: { body: html(`${ORIGIN}/live`, oversizeUrl) },
      [`${ORIGIN}/live`]: { body: html() },
    };

    const fetched: string[] = [];
    const fetcher = buildFetcher(site, fetched);

    const crawlId = await Effect.runPromise(
      Effect.gen(function* () {
        const crawler = yield* createCrawler({ fetcher, config: BASE_CONFIG });
        const id = yield* crawler.start(ORIGIN);
        // The oversize URL must never be dispatched to the fetcher.
        expect(fetched).not.toContain(oversizeUrl);
        expect(fetched).toContain(`${ORIGIN}/live`);

        // The frontier must still have a record of it, skipped with a
        // diagnosable reason — the same pattern used for scope/robots skips.
        const entries = yield* crawler.storage.getAllFrontierEntries(id);
        const skipped = entries.find((e) => e.normalizedUrl === oversizeUrl);
        expect(skipped).toBeDefined();
        expect(skipped?.status).toBe("skipped");
        expect(skipped?.reason).toBe("url_too_long");

        return id;
      }),
    );

    expect(crawlId).toBeTruthy();
  });

  test("oversize seed URL is refused, not just discovered links", async () => {
    // #1229: the seed path funnels through the same enqueueUrl choke point,
    // so an oversize start URL must also be refused rather than crashing the
    // crawl or producing an oversize pages[].url from depth 0.
    const oversizeOrigin = `https://${"a".repeat(REPORT_LIMITS.maxUrlLength)}.example.com`;
    expect(oversizeOrigin.length).toBeGreaterThan(REPORT_LIMITS.maxUrlLength);

    const fetched: string[] = [];
    const fetcher = buildFetcher({}, fetched);

    await Effect.runPromise(
      Effect.gen(function* () {
        const crawler = yield* createCrawler({ fetcher, config: BASE_CONFIG });
        const id = yield* crawler.start(oversizeOrigin);
        expect(fetched).not.toContain(oversizeOrigin);

        const entries = yield* crawler.storage.getAllFrontierEntries(id);
        const skipped = entries.find((e) => e.normalizedUrl === `${oversizeOrigin}/`);
        expect(skipped).toBeDefined();
        expect(skipped?.status).toBe("skipped");
        expect(skipped?.reason).toBe("url_too_long");
      }),
    );
  });
});
