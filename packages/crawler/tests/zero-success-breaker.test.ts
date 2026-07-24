// #924 — the zero-success crawl breaker aborts a crawl whose every page store
// fails, within a bounded number of attempts (<< maxPages), instead of hanging.
//
// Root cause this pins (see PR #924): a store failure inside processUrl used to
// hit a `try/finally` host-slot release that Effect.gen does NOT run on effect
// failure — the per-host slot leaked and the next same-host fetch deadlocked in
// acquire(), so the crawl wedged after ~perHostConcurrency fetches and the
// breaker's attempt counter never advanced. The Effect.ensuring conversion in
// crawler.ts guarantees the release on failure/interrupt, so the pool keeps
// draining and the breaker trips at max(8, concurrency*2) attempts.

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
import type { CrawlStorage } from "../src/storage/types";
import { StorageError } from "../src/storage/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";

const ORIGIN = "https://example.com";

const EMPTY_RESPONSE_HEADERS = {
  contentType: null, contentEncoding: null, cacheControl: null, expires: null,
  vary: null, etag: null, server: null, lastModified: null, link: null,
  serverTiming: null, age: null, xCache: null, cfCacheStatus: null,
  xVercelCache: null, altSvc: null, acceptRanges: null,
} as const;
const EMPTY_SECURITY_HEADERS = {
  hsts: null, csp: null, xFrameOptions: null, xContentTypeOptions: null,
  referrerPolicy: null, permissionsPolicy: null, xRobotsTag: null,
} as const;

// A root linking to `n` leaf pages so the frontier stays full (> breaker
// threshold) — proving the breaker, not frontier exhaustion, ends the crawl.
function hubSite(n: number): Record<string, string> {
  const links = Array.from({ length: n }, (_, i) => `/p${i}`);
  const anchors = links.map((h) => `<a href="${ORIGIN}${h}">${h}</a>`).join("");
  const site: Record<string, string> = {
    [`${ORIGIN}/`]: `<!doctype html><html><body>${anchors}</body></html>`,
  };
  for (const h of links) site[`${ORIGIN}${h}`] = "<!doctype html><html><body></body></html>";
  return site;
}

function fixtureFetcher(site: Record<string, string>): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      const body = site[url] ?? "";
      const status = site[url] !== undefined ? 200 : 404;
      yield* applyStatusGuards(url, status, new Headers(), body);
      return {
        url, finalUrl: url, status, loadTime: 1, ttfb: 1, downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html" },
        securityHeaders: EMPTY_SECURITY_HEADERS, contentType: "text/html",
        body, sizeBytes: body.length,
        redirectChain: { sourceUrl: url, finalUrl: url, hops: [], chainLength: 0, isLoop: false, endsInError: false, httpsToHttp: false, httpToHttps: false },
        fetcherId: undefined, fallbackReason: undefined,
      };
    });
}

// Wrap real in-memory storage, overriding upsertPage to always fail — the
// synthetic "every page store rejects" condition (#921 class: a pages-table
// column gap made every INSERT throw).
function failingUpsertStorage(base: CrawlStorage): CrawlStorage {
  return new Proxy(base, {
    get(target, prop, recv) {
      if (prop === "upsertPage") {
        return () => Effect.fail(StorageError.write(new Error("synthetic upsertPage failure")));
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

const BASE_CONFIG: Partial<CrawlerConfig> = {
  perHostConcurrency: 1, delayMs: 0, perHostDelayMs: 0, timeoutMs: 1000,
  userAgent: "test", respectRobots: false, incremental: false,
  useCacheControl: false, breadthFirst: false, disableLinkDiscovery: false,
  coverageMode: "full", maxPages: 100,
};

interface BreakerOutcome {
  fetchingEvents: number;
  completed: boolean;
  status: string | undefined;
  isRunning: boolean;
  pageCount: number;
}

// Runs a crawl against a storage whose every upsertPage fails, bounded by a
// hard test timeout so a regression (deadlock) fails loudly instead of hanging.
function runBreakerCrawl(concurrency: number): Promise<BreakerOutcome> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const res = new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return Promise.resolve(res);
  }) as typeof globalThis.fetch;

  const program = Effect.gen(function* () {
    const base = yield* createTestStorage();
    const storage = failingUpsertStorage(base);
    const crawler = yield* createCrawler({
      fetcher: fixtureFetcher(hubSite(60)),
      storage,
      config: { ...BASE_CONFIG, concurrency, perHostConcurrency: 1 },
    });

    let fetchingEvents = 0;
    let completed = false;
    const collector = yield* Stream.runForEach(
      crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
      (e: CrawlerEvent) =>
        Effect.sync(() => {
          if (e.type === "page:fetching") fetchingEvents++;
          if (e.type === "completed") completed = true;
        }),
    ).pipe(Effect.fork);
    yield* Effect.yieldNow();

    // A deadlock regression would hang start() forever; the timeout converts
    // that into a test failure (crawlDone=false) rather than a wedged suite.
    const crawlResult = yield* crawler
      .start(ORIGIN)
      .pipe(Effect.timeout(Duration.seconds(10)), Effect.either);
    const crawlId = crawler.currentCrawlId!;

    yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
    yield* Fiber.interrupt(collector);

    const crawl = yield* base.getCrawl(crawlId).pipe(Effect.orElseSucceed(() => null));
    const pageCount = yield* base.getPageCount(crawlId).pipe(Effect.orElseSucceed(() => -1));

    return {
      fetchingEvents,
      completed: completed && crawlResult._tag === "Right",
      status: crawl?.status,
      isRunning: crawler.isRunning,
      pageCount,
    } satisfies BreakerOutcome;
  });

  return Effect.runPromise(program).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe("zero-success crawl breaker (#924)", () => {
  test("concurrency=1: aborts at the max(8, concurrency*2)=8 attempt threshold, no hang", async () => {
    const out = await runBreakerCrawl(1);

    // Terminated (did not deadlock) with zero pages stored.
    expect(out.completed).toBe(true);
    expect(out.isRunning).toBe(false);
    expect(out.pageCount).toBe(0);
    // Bounded attempts: the breaker fires at 8, far below maxPages (100). One
    // extra in-flight fetch may settle before the flag is observed, so allow a
    // tiny margin above the threshold but well under the frontier size.
    const threshold = Math.max(8, 1 * 2);
    expect(out.fetchingEvents).toBeGreaterThanOrEqual(threshold);
    expect(out.fetchingEvents).toBeLessThanOrEqual(threshold + 2);
  });

  test("concurrency=5: aborts at the max(8, concurrency*2)=10 attempt threshold, no hang", async () => {
    const out = await runBreakerCrawl(5);

    expect(out.completed).toBe(true);
    expect(out.isRunning).toBe(false);
    expect(out.pageCount).toBe(0);
    const threshold = Math.max(8, 5 * 2);
    expect(out.fetchingEvents).toBeGreaterThanOrEqual(threshold);
    // Under concurrency N up to N in-flight attempts can settle in the wave
    // that trips the flag; stays far below maxPages regardless.
    expect(out.fetchingEvents).toBeLessThanOrEqual(threshold + 5);
    expect(out.fetchingEvents).toBeLessThan(60);
  });
});
