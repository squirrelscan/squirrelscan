// #1829 — crawl-level behaviour when a host throttles.
//
// Asserts the things a unit test of the registry cannot: that a permanently
// rate-limiting host is given up on inside its backoff budget rather than
// grinding a full retry schedule per URL, that the crawl still FINISHES, that
// the pages lost that way are counted as rate-limited (not blocked, not broken),
// and that the backoff is announced while it happens.
//
// Deliberately driven through `config.documentFetcher` rather than the
// `createCrawler({ fetcher })` test seam: the seam REPLACES `fetchPageWithRetry`
// outright, so it would bypass the retry loop that owns the whole backoff
// schedule and the test would pass against a fetcher that does nothing. This is
// the same path the cloud runner takes.
//
// `max_backoff_ms` is set very low so the schedule plays out in real time inside
// a test timeout. The clock-precise assertions live in rate-limit-backoff.test.ts.

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
import type { CrawlerConfig, CrawlerEvent, RateLimitEvent } from "../src/core/types";

const ORIGIN = "https://shop.example.com";

function html(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

/** A root page linking to `n` leaves, so the frontier has work beyond the seed. */
function hubSite(n: number): Record<string, string> {
  const site: Record<string, string> = {};
  const anchors = Array.from({ length: n }, (_, i) => `<a href="${ORIGIN}/p${i}">p${i}</a>`).join(
    "",
  );
  site[`${ORIGIN}/`] = html(anchors);
  for (let i = 0; i < n; i++) site[`${ORIGIN}/p${i}`] = html(`leaf ${i}`);
  return site;
}

interface FetcherOptions {
  /** Statuses answered per request, in order, before settling into `then`. */
  script?: number[];
  /** Status answered once the script runs out. 200 serves the fixture page. */
  then: number;
  /** Retry-After header attached to every throttled response. */
  retryAfter?: string;
}

/**
 * A DocumentFetcher answering a scripted status sequence. Its responses go
 * through the production `applyStatusGuards` inside `fetchWithDocumentFetcher`,
 * so classification here is real behaviour rather than a double's opinion.
 */
function scriptedFetcher(site: Record<string, string>, options: FetcherOptions) {
  const requests: string[] = [];
  let served = 0;

  const fetcher = {
    id: "scripted",
    fetch: async ({ url }: { url: string }) => {
      requests.push(url);
      const status = options.script?.[served] ?? options.then;
      served += 1;

      const headers: Record<string, string> = { "content-type": "text/html" };
      if (options.retryAfter && status !== 200) headers["retry-after"] = options.retryAfter;
      const body = status === 200 ? (site[url] ?? "") : "";

      return {
        url,
        finalUrl: url,
        status: status === 200 && !site[url] ? 404 : status,
        headers,
        body,
        timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
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
      };
    },
  };

  return { fetcher, requests: () => requests };
}

const BASE_CONFIG: Partial<CrawlerConfig> = {
  concurrency: 2,
  perHostConcurrency: 2,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 500,
  userAgent: "test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  disableLinkDiscovery: false,
  coverageMode: "full",
  maxPages: 12,
  // Tiny, so a whole give-up schedule runs in well under a second.
  maxBackoffMs: 200,
};

interface CrawlOutcome {
  finished: boolean;
  durationMs: number;
  pagesFetched: number;
  pagesFailed: number;
  pagesBlocked: number;
  pagesRateLimited: number;
  requests: number;
  rateLimitEvents: Extract<CrawlerEvent, { type: "rate-limited" }>[];
  hookEvents: RateLimitEvent[];
  frontierFailures: string[];
}

async function runCrawl(
  options: FetcherOptions,
  configOverrides: Partial<CrawlerConfig> = {},
  site = hubSite(10),
): Promise<CrawlOutcome> {
  const hookEvents: RateLimitEvent[] = [];
  const rateLimitEvents: Extract<CrawlerEvent, { type: "rate-limited" }>[] = [];

  // The preamble (seed-redirect resolution, robots.txt, the AX probes) uses the
  // global fetch, not the document fetcher. Stub it so nothing leaves the box
  // and the probes settle instantly.
  const originalFetch = globalThis.fetch;
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

  const program = Effect.gen(function* () {
    const storage = yield* createTestStorage();
    const { fetcher, requests } = scriptedFetcher(site, options);
    const crawler = yield* createCrawler({
      storage,
      config: {
        ...BASE_CONFIG,
        ...configOverrides,
        documentFetcher: fetcher as unknown as CrawlerConfig["documentFetcher"],
        onRateLimitEvent: (event) => hookEvents.push(event),
      },
    });

    const collector = yield* Stream.runForEach(
      crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
      (e: CrawlerEvent) =>
        Effect.sync(() => {
          if (e.type === "rate-limited") rateLimitEvents.push(e);
        }),
    ).pipe(Effect.fork);
    yield* Effect.yieldNow();

    const startedAt = Date.now();
    // A crawl that never gives up on a throttling host would hang here; the
    // timeout turns that regression into a failure, not a wedged suite.
    const result = yield* crawler
      .start(ORIGIN)
      .pipe(Effect.timeout(Duration.seconds(20)), Effect.either);
    const durationMs = Date.now() - startedAt;
    const crawlId = crawler.currentCrawlId!;

    yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
    yield* Fiber.interrupt(collector);

    const stats = yield* storage.getStats(crawlId).pipe(Effect.orElseSucceed(() => null));
    const frontier = yield* storage
      .getAllFrontierEntries(crawlId)
      .pipe(Effect.orElseSucceed(() => []));

    return {
      finished: result._tag === "Right",
      durationMs,
      pagesFetched: stats?.pagesFetched ?? -1,
      pagesFailed: stats?.pagesFailed ?? -1,
      pagesBlocked: stats?.pagesBlocked ?? 0,
      pagesRateLimited: stats?.pagesRateLimited ?? 0,
      requests: requests().length,
      rateLimitEvents,
      hookEvents,
      frontierFailures: frontier
        .filter((row) => row.status === "failed")
        .map((row) => row.reason ?? ""),
    } satisfies CrawlOutcome;
  });

  return Effect.runPromise(program).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

/** Seed succeeds, then the host throttles everything: the Shopify shape. */
const THROTTLES_AFTER_SEED: FetcherOptions = { script: [200], then: 429 };

describe("crawl-wide rate limiting (#1829)", () => {
  test("a host that starts throttling is given up on, and the crawl still finishes", async () => {
    const out = await runCrawl(THROTTLES_AFTER_SEED);

    expect(out.finished).toBe(true);
    // Bounded by max_backoff_ms, not by frontier size.
    expect(out.durationMs).toBeLessThan(20_000);
    // The seed was fetched before throttling began, so real content survived.
    expect(out.pagesFetched).toBe(1);
    expect(out.pagesRateLimited).toBeGreaterThan(0);
    // The key regression: throttling is NOT bot-walling, so it must stay out
    // of pagesBlocked, which drives the "your site blocked us" verdict.
    expect(out.pagesBlocked).toBe(0);
    // Rate-limited pages are a subset of pagesFailed.
    expect(out.pagesFailed).toBeGreaterThanOrEqual(out.pagesRateLimited);
  }, 30_000);

  test("once the host has spent its budget, remaining URLs are recorded without further requests", async () => {
    const out = await runCrawl(THROTTLES_AFTER_SEED);

    expect(out.frontierFailures.length).toBeGreaterThan(0);
    // Every failed row says rate limited — not "404", not "Server error".
    for (const message of out.frontierFailures) {
      expect(message.toLowerCase()).toContain("rate limit");
    }
    // The give-up is what bounds the work. Without it each of the 10 leaves
    // would run its own six-attempt schedule (60+ requests).
    expect(out.requests).toBeLessThan(12);
    // More URLs were recorded than were ever requested, which is the proof
    // that the tail was marked without touching the network.
    expect(out.pagesRateLimited).toBeGreaterThan(out.requests - 1);
  }, 30_000);

  test("a backoff is announced on the event stream and the config hook while it waits", async () => {
    const out = await runCrawl(THROTTLES_AFTER_SEED);

    expect(out.rateLimitEvents.length).toBeGreaterThan(0);
    const event = out.rateLimitEvents[0]!;
    expect(event.host).toContain("shop.example.com");
    expect(event.backoffMs).toBeGreaterThan(0);
    expect(event.attempt).toBeGreaterThanOrEqual(1);
    expect(event.url).toContain(ORIGIN);

    // The synchronous hook is what the CLI progress line reads, and it fires
    // BEFORE the sleep — otherwise the message describes a wait already over.
    expect(out.hookEvents.length).toBeGreaterThan(0);
    expect(out.hookEvents[0]!.host).toContain("shop.example.com");
  }, 30_000);

  test("Retry-After is carried onto the backoff the crawl reports", async () => {
    const out = await runCrawl({ ...THROTTLES_AFTER_SEED, retryAfter: "1" });
    expect(out.hookEvents.length).toBeGreaterThan(0);
    expect(out.hookEvents[0]!.retryAfterMs).toBe(1_000);
  }, 30_000);

  test("a burst that recovers is retried through, losing no pages", async () => {
    // One throttled response, then the host behaves — the shape a storefront
    // produces under a short burst. Before #1829 the retry budget was ~1.5s
    // and the page was recorded as failed.
    const out = await runCrawl({ script: [429], then: 200 });

    expect(out.finished).toBe(true);
    expect(out.pagesFetched).toBeGreaterThan(0);
    expect(out.pagesRateLimited).toBe(0);
    expect(out.pagesBlocked).toBe(0);
    // It did back off rather than simply succeeding on a lucky first try.
    expect(out.hookEvents.length).toBe(1);
  }, 30_000);

  test("430 drives the same crawl-wide backoff as 429", async () => {
    const out = await runCrawl({ script: [200], then: 430 });

    expect(out.finished).toBe(true);
    expect(out.pagesRateLimited).toBeGreaterThan(0);
    expect(out.pagesBlocked).toBe(0);
    expect(out.rateLimitEvents.length).toBeGreaterThan(0);
  }, 30_000);

  test("a 503 carrying Retry-After is treated as throttling, a bare 503 is not", async () => {
    const throttled = await runCrawl({ script: [200], then: 503, retryAfter: "1" });
    expect(throttled.pagesRateLimited).toBeGreaterThan(0);
    expect(throttled.rateLimitEvents.length).toBeGreaterThan(0);

    const outage = await runCrawl({ script: [200], then: 503 });
    expect(outage.pagesRateLimited).toBe(0);
    expect(outage.rateLimitEvents.length).toBe(0);
  }, 30_000);

  test("a 403 still counts as blocked, not rate limited", async () => {
    const out = await runCrawl({ script: [200], then: 403 });

    expect(out.finished).toBe(true);
    expect(out.pagesBlocked).toBeGreaterThan(0);
    expect(out.pagesRateLimited).toBe(0);
    expect(out.rateLimitEvents.length).toBe(0);
  }, 30_000);
});
