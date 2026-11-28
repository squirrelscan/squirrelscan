import type { CrawlerEvent, CrawlStats } from "@squirrelscan/core-contracts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";

import type { CrawlerConfig } from "../src/core/types";
import type {
  RedirectChain,
  ResponseHeaders,
  SecurityHeaders,
} from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import { SQLiteStorage } from "../src/storage/sqlite";

const APEX = "https://example.com";
const WWW = "https://www.example.com";

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

function redirectChain(sourceUrl: string, finalUrl: string): RedirectChain {
  return {
    sourceUrl,
    finalUrl,
    hops: [],
    chainLength: sourceUrl === finalUrl ? 0 : 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

interface Page {
  body: string;
  /** Where the fetch actually landed, when the origin redirected. */
  finalUrl?: string;
}

/**
 * The page-fetch seam. Deliberately NOT the preamble: the seed-redirect probe,
 * robots.txt and the AX sweep all go through `globalThis.fetch`, which the
 * tests stub separately so the two vantages can disagree: which is the whole
 * failure being reproduced.
 */
const CHALLENGE_HTML =
  "<html><head><title>Just a moment...</title></head><body>" +
  '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
  "Enable JavaScript and cookies to continue</body></html>";

let challengedHosts: Set<string>;
const isChallenged = (url: string): boolean =>
  challengedHosts.has(new URL(url).host);

function buildFetcher(
  site: Record<string, Page>,
  fetched: string[]
): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      fetched.push(url);
      if (isChallenged(url)) {
        yield* applyStatusGuards(
          url,
          403,
          new Headers({ "cf-mitigated": "challenge", server: "cloudflare" }),
          CHALLENGE_HTML
        );
      }
      const page = site[url];
      const status = page ? 200 : 404;
      const body = page?.body ?? "";
      yield* applyStatusGuards(url, status, new Headers(), body);
      const contentType = page ? "text/html" : "text/plain";
      const finalUrl = page?.finalUrl ?? url;
      return {
        url,
        finalUrl,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType, setCookie: null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType,
        body,
        sizeBytes: body.length,
        redirectChain: redirectChain(url, finalUrl),
      };
    });
}

function linksTo(...urls: string[]): string {
  const anchors = urls.map((u) => `<a href="${u}">link</a>`).join("");
  return `<!doctype html><html><head><title>Home</title></head><body>${anchors}</body></html>`;
}

const CONFIG: Partial<CrawlerConfig> = {
  maxPages: 10,
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 1000,
  userAgent: "squirrel-test-agent",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: false,
  coverageMode: "full",
};

let originalFetch: typeof globalThis.fetch;

/** The preamble's vantage: a challenged host answers the cf challenge, the rest answer 200 HTML. */
function stubPreamble(): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (isChallenged(url)) {
      return Promise.resolve(
        new Response(CHALLENGE_HTML, {
          status: 403,
          headers: {
            "content-type": "text/html",
            "cf-mitigated": "challenge",
            server: "cloudflare",
          },
        })
      );
    }
    if (url.endsWith("/")) {
      return Promise.resolve(
        new Response(linksTo(), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  challengedHosts = new Set();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function crawl(
  site: Record<string, Page>
): Promise<{ baseUrl: string; stats: CrawlStats; stored: string[] }> {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawler = yield* createCrawler({
        fetcher: buildFetcher(site, []),
        storage,
        config: CONFIG,
      });
      const collector = yield* Stream.runForEach(
        crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
        (_event: CrawlerEvent) => Effect.void
      ).pipe(Effect.fork);
      yield* Effect.yieldNow();
      const crawlId = yield* crawler.start(`${APEX}/`, `${APEX}/`);
      yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(10)));
      const crawlRow = yield* storage.getCrawl(crawlId);
      const pages = yield* storage.getPages(crawlId);
      return {
        baseUrl: crawlRow!.baseUrl,
        stats: crawlRow!.stats,
        stored: pages
          .filter((page) => page.status === 200)
          .map((page) => page.normalizedUrl),
      };
    })
  );
}

const SITE: Record<string, Page> = {
  [`${APEX}/`]: { body: linksTo(`${APEX}/a`) },
  [`${APEX}/a`]: { body: linksTo() },
  [`${WWW}/`]: { body: linksTo(`${WWW}/a`) },
  [`${WWW}/a`]: { body: linksTo() },
};

describe("seed twin fallback (#2257)", () => {
  test("apex challenged, www ok: the audit runs on www and the stats say why", async () => {
    challengedHosts = new Set(["example.com"]);
    stubPreamble();
    const { baseUrl, stats, stored } = await crawl(SITE);

    expect(baseUrl).toBe(WWW);
    expect(stored).toContain(`${WWW}/`);
    expect(stored).toContain(`${WWW}/a`);
    expect(stats.wafBlocked?.seed).toBeUndefined();
    expect(stats.seedTwin?.fromHost).toBe("example.com");
    expect(stats.seedTwin?.toHost).toBe("www.example.com");
    expect(stats.seedTwin?.status).toBe(403);
    expect(stats.seedTwin?.reason).toContain("www.example.com");
  });

  test("both hosts challenged: the audit fails as blocked, no fallback", async () => {
    challengedHosts = new Set(["example.com", "www.example.com"]);
    stubPreamble();
    const { baseUrl, stats } = await crawl(SITE);

    expect(baseUrl).toBe(APEX);
    expect(stats.seedTwin).toBeUndefined();
    expect(stats.wafBlocked?.seed?.url).toContain("example.com");
  });

  test("apex ok: unchanged, no fallback recorded", async () => {
    stubPreamble();
    const { baseUrl, stats, stored } = await crawl(SITE);

    expect(baseUrl).toBe(APEX);
    expect(stats.seedTwin).toBeUndefined();
    expect(stored).toContain(`${APEX}/a`);
  });
});
