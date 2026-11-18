// #2036 - a page that is still 5xx after the fetcher's retries is stored as an error page, so
// `crawl/server-errors` can report it.

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import type { CrawlerConfig } from "../src/core/types";

const ORIGIN = "https://example.com";

const EMPTY_RESPONSE_HEADERS = {
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
} as const;
const EMPTY_SECURITY_HEADERS = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
} as const;

const BASE_CONFIG: Partial<CrawlerConfig> = {
  concurrency: 1,
  perHostConcurrency: 1,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 500,
  userAgent: "test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: true,
  coverageMode: "full",
  maxPages: 2,
};


/** A fetcher that answers every URL with one status and an optional body. */
function statusFetcher(
  status: number,
  body = "",
  // Optional per-URL override, so a healthy seed can link to a failing page.
  override?: (url: string) => { status: number; body: string } | undefined,
): CrawlFetcher {
  return (rawUrl) =>
    Effect.gen(function* () {
      const url = rawUrl;
      const o = override?.(url);
      const status_ = o?.status ?? status;
      const body_ = o?.body ?? body;
      yield* applyStatusGuards(url, status_, new Headers(), body_);
      return {
        url,
        finalUrl: url,
        status: status_,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html" },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType: "text/html",
        body: body_,
        sizeBytes: body_.length,
        redirectChain: {
          sourceUrl: url,
          finalUrl: url,
          hops: [],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
        fetcherId: undefined,
        fallbackReason: undefined,
      };
    });
}

/** Stub the root probes (robots.txt, llms.txt, sitemaps) so they cost nothing. */
function withStubbedRootProbes<T>(robotsBody: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const isRobots = url.endsWith("/robots.txt");
    const res = new Response(isRobots ? robotsBody : "", {
      status: isRobots ? 200 : 404,
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return Promise.resolve(res);
  }) as typeof globalThis.fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}


async function crawlStatus(fetcher: CrawlFetcher, path = "/"): Promise<number | null> {
  const program = Effect.gen(function* () {
    const storage = yield* createTestStorage();
    const crawler = yield* createCrawler({
      fetcher,
      storage,
      config: { ...BASE_CONFIG },
    });
    const drain = yield* Stream.runDrain(
      crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
    ).pipe(Effect.fork);
    yield* Effect.yieldNow();
    yield* crawler.start(ORIGIN).pipe(Effect.timeout(Duration.seconds(10)), Effect.either);
    const crawlId = crawler.currentCrawlId!;
    yield* Effect.ignore(drain.await);
    const page = yield* storage.getPage(crawlId, `${ORIGIN}${path}`).pipe(Effect.orElseSucceed(() => null));
    return page?.status ?? null;
  });
  return Effect.runPromise(program);
}

describe("a 5xx page is stored (#2036)", () => {
  test.each([500, 503])("a %i page linked from a healthy seed is stored with its status", async (status) => {
    const fetcher = statusFetcher(200, "", (url) =>
      url === `${ORIGIN}/broken`
        ? { status, body: "" }
        : { status: 200, body: '<html><body><a href="/broken">b</a></body></html>' },
    );
    const stored = await withStubbedRootProbes("", () => crawlStatus(fetcher, "/broken"));
    expect(stored).toBe(status);
  });

  test.each([500, 503])("a %i seed is not stored: a down site is a failed audit with no pages", async (status) => {
    const stored = await withStubbedRootProbes("", () => crawlStatus(statusFetcher(status)));
    expect(stored).toBeNull();
  });

  test("a healthy page is stored as 200", async () => {
    const stored = await withStubbedRootProbes("", () =>
      crawlStatus(statusFetcher(200, "<html><body>ok</body></html>")),
    );
    expect(stored).toBe(200);
  });
});
