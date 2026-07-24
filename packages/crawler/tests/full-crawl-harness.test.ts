// #315 — deterministic full-crawl integration harness. The crawl loop's page
// fetch is an injectable seam (createCrawler({ fetcher })) defaulting to the
// real fetchPageWithRetry, so full-crawl behaviors — maxPages cap, frontier
// drain, cycle/no-hang termination — can be exercised in-memory with no
// network or real timers. globalThis.fetch is stubbed only to neutralize the
// pre-crawl preamble (redirect detection + sitemap probing); the crawl loop
// itself runs entirely through the injected fetcher.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";

import type { ParsedPageCache } from "@squirrelscan/parser";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { applyStatusGuards, type CrawlFetcher, type FetchOptions } from "../src/fetcher";
import type {
  CrawlStats,
  PageRecord,
  RedirectChain,
  ResponseHeaders,
  SecurityHeaders,
} from "../src/storage/types";

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

// Config that makes the crawl loop deterministic: no network preamble effect,
// no politeness delays, link discovery on, no breadth-first prefix budgeting
// (which would otherwise skip same-prefix pages mid-crawl).
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

type FixturePage = {
  status?: number;
  body?: string;
  contentType?: string | null;
  fetcherId?: string;
  fallbackReason?: string;
  setCookie?: string | null;
};
type Site = Record<string, FixturePage>;

// A fixture-backed CrawlFetcher: serves each known URL's body/status, returns a
// 404 for anything unmapped (a broken link). Optionally records every fetched
// URL and yields the fiber so concurrent workers genuinely interleave.
function buildFetcher(
  site: Site,
  opts: {
    onFetch?: (url: string) => void;
    onOptions?: (options: FetchOptions) => void;
    yieldEach?: boolean;
  } = {},
): CrawlFetcher {
  return (url, options) =>
    Effect.gen(function* () {
      if (opts.yieldEach) yield* Effect.yieldNow();
      opts.onFetch?.(url);
      opts.onOptions?.(options);
      const page = site[url];
      const status = page?.status ?? (page ? 200 : 404);
      const body = page?.body ?? "";
      // Route the fixture status through the real classification guard so error
      // statuses (403/429/5xx) fail the fetch exactly like the production
      // fetcher — driving the crawl loop's fetch-error branch, not a
      // hand-crafted CrawlError (#802).
      yield* applyStatusGuards(url, status, new Headers(), body);
      const contentType = page === undefined ? "text/plain" : (page.contentType ?? "text/html");
      return {
        url,
        finalUrl: url,
        status,
        loadTime: 1,
        ttfb: 1,
        downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType, setCookie: page?.setCookie ?? null },
        securityHeaders: EMPTY_SECURITY_HEADERS,
        contentType,
        body,
        sizeBytes: body.length,
        redirectChain: noRedirectChain(url),
        // #512: served-by egress/method + any fallback reason, threaded to PageRecord.
        fetcherId: page?.fetcherId,
        fallbackReason: page?.fallbackReason,
      };
    });
}

// Build an HTML body that links to the given paths (relative to ORIGIN).
function html(...links: string[]): string {
  const anchors = links.map((href) => `<a href="${ORIGIN}${href}">${href}</a>`).join("");
  return `<!doctype html><html><body>${anchors}</body></html>`;
}

interface CrawlOutcome {
  crawlId: string;
  events: CrawlerEvent[];
  pages: PageRecord[];
  stats: CrawlStats | null;
  status: string | undefined;
  isRunning: boolean;
  pending: number;
  fetching: number;
  fetched: string[];
  fetchOptions: FetchOptions[];
}

function runCrawl(args: {
  site: Site;
  config?: Partial<CrawlerConfig>;
  seed?: string;
  yieldEach?: boolean;
  parsedPageCache?: ParsedPageCache;
}): Promise<CrawlOutcome> {
  const fetched: string[] = [];
  const fetchOptions: FetchOptions[] = [];
  const fetcher = buildFetcher(args.site, {
    onFetch: (u) => fetched.push(u),
    onOptions: (o) => fetchOptions.push(o),
    yieldEach: args.yieldEach,
  });

  const program = Effect.gen(function* () {
    const crawler = yield* createCrawler({
      fetcher,
      config: { ...BASE_CONFIG, ...args.config },
      parsedPageCache: args.parsedPageCache,
    });
    const events: CrawlerEvent[] = [];
    // Collect events until the terminal "completed" event ends the stream
    // naturally — no reliance on yield timing. The safety timeout + interrupt
    // guarantee no hang/leak if "completed" is somehow never seen.
    const collector = yield* Stream.runForEach(
      crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
      (e) =>
        Effect.sync(() => {
          events.push(e);
        }),
    ).pipe(Effect.fork);
    // Ensure the subscriber attaches to the PubSub before the crawl emits.
    yield* Effect.yieldNow();

    const crawlId = yield* crawler.start(args.seed ?? ORIGIN);

    yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(5)), Effect.ignore);
    yield* Fiber.interrupt(collector);

    const storage = crawler.storage;
    const pages = yield* storage.getPages(crawlId);
    const stats = yield* storage.getStats(crawlId);
    const crawl = yield* storage.getCrawl(crawlId);
    const pending = yield* storage.getPendingCount(crawlId);
    const fetching = yield* storage.getFetchingCount(crawlId);

    return {
      crawlId,
      events,
      pages,
      stats,
      status: crawl?.status,
      isRunning: crawler.isRunning,
      pending,
      fetching,
      fetched,
      fetchOptions,
    } satisfies CrawlOutcome;
  });

  return Effect.runPromise(program);
}

describe("full-crawl integration harness (#315)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Neutralize the pre-crawl preamble: detectRedirects, robots.txt, and
    // sitemap probing all hit globalThis.fetch. A 404 text/plain response means
    // "no redirect, no sitemap" — keeping the harness fully offline.
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const res = new Response("", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("injected fetcher receives the crawl-loop requests (seam is wired)", async () => {
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/a") },
      [`${ORIGIN}/a`]: { body: html() },
    };
    const out = await runCrawl({ site });

    // Every page came through the injected fetcher — no real network was used.
    expect(out.fetched).toContain(`${ORIGIN}/`);
    expect(out.fetched).toContain(`${ORIGIN}/a`);
    expect(out.pages.map((p) => p.normalizedUrl).sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
  });

  test("#512: fetcherId/fallbackReason from the fetch result are persisted onto the PageRecord", async () => {
    const site: Site = {
      // Homepage served via cloud render; a subpage recovered via the direct-fetch
      // fallback after a render block — both fetch-result fields must round-trip.
      [`${ORIGIN}/`]: { body: html("/a"), fetcherId: "cloud-render" },
      [`${ORIGIN}/a`]: { body: html(), fetcherId: "fetch", fallbackReason: "render-block" },
    };
    const out = await runCrawl({ site });

    const byUrl = new Map(out.pages.map((p) => [p.normalizedUrl, p]));
    expect(byUrl.get(`${ORIGIN}/`)?.fetcherId).toBe("cloud-render");
    expect(byUrl.get(`${ORIGIN}/`)?.fallbackReason).toBeUndefined();
    expect(byUrl.get(`${ORIGIN}/a`)?.fetcherId).toBe("fetch");
    expect(byUrl.get(`${ORIGIN}/a`)?.fallbackReason).toBe("render-block");
  });

  // #748: security/cookie-flags reads PageRecord.headers.setCookie — a header
  // added to the fetch result but never threaded into the PageRecord the
  // crawler stores would make that rule silently inert against every real
  // crawled page. This exercises the actual `headers` object built in
  // packages/crawler/src/core/crawler.ts, not a hand-built PageRecord fixture.
  test("#748: set-cookie from the fetch result is persisted onto the PageRecord", async () => {
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/a"), setCookie: "session=abc123; Path=/; HttpOnly" },
      [`${ORIGIN}/a`]: { body: html() }, // no cookies set on this page
    };
    const out = await runCrawl({ site });

    const byUrl = new Map(out.pages.map((p) => [p.normalizedUrl, p]));
    expect(byUrl.get(`${ORIGIN}/`)?.headers.setCookie).toBe("session=abc123; Path=/; HttpOnly");
    expect(byUrl.get(`${ORIGIN}/a`)?.headers.setCookie).toBeNull();
  });

  // #441 — the seam must forward the per-fetch FetchOptions, not just the URL,
  // so a regression that drops userAgent/timeoutMs (sending defaults instead of
  // the configured crawl settings) is caught.
  test("injected fetcher receives the configured FetchOptions (seam forwards options)", async () => {
    // Two linked pages so the seam is exercised on more than one fetch — the
    // every() check below then genuinely guards the per-fetch path, not a
    // single one-element array.
    const out = await runCrawl({
      site: {
        [`${ORIGIN}/`]: { body: html("/a") },
        [`${ORIGIN}/a`]: { body: html() },
      },
      // Set followRedirects explicitly so the test asserts forwarding, not the
      // CrawlerConfig default value.
      config: { userAgent: "squirrel-test/9.9", timeoutMs: 4321, followRedirects: true },
    });

    expect(out.fetchOptions.length).toBe(2);
    for (const opts of out.fetchOptions) {
      // Every forwarded fetch carries the configured options — no request
      // silently falls back to a default userAgent/timeout/redirect policy.
      expect(opts.userAgent).toBe("squirrel-test/9.9");
      expect(opts.timeoutMs).toBe(4321);
      expect(opts.followRedirects).toBe(true);
      // Non-incremental crawl forwards an (empty) conditional-headers record.
      expect(opts.headers).toEqual({});
    }
  });

  test("frontier-drain termination crawls every reachable page exactly once", async () => {
    // Interlinked graph with cycles back to root; 7 unique reachable pages.
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/a", "/b", "/c") },
      [`${ORIGIN}/a`]: { body: html("/a1", "/a2", "/") },
      [`${ORIGIN}/b`]: { body: html("/b1", "/") },
      [`${ORIGIN}/c`]: { body: html("/") },
      [`${ORIGIN}/a1`]: { body: html("/") },
      [`${ORIGIN}/a2`]: { body: html("/") },
      [`${ORIGIN}/b1`]: { body: html("/") },
    };
    const out = await runCrawl({ site, config: { maxPages: 100 } });

    expect(out.pages.map((p) => p.normalizedUrl).sort()).toEqual(Object.keys(site).sort());
    // No page fetched twice despite the cycles.
    expect(out.fetched.length).toBe(Object.keys(site).length);
    expect(new Set(out.fetched).size).toBe(out.fetched.length);
    // Terminated cleanly: frontier drained, crawl marked complete.
    expect(out.pending).toBe(0);
    expect(out.fetching).toBe(0);
    expect(out.status).toBe("completed");
    expect(out.isRunning).toBe(false);
    expect(out.events.some((e) => e.type === "completed")).toBe(true);
  });

  test("maxPages cap is never overshot (serial)", async () => {
    // Hub linking to 29 leaves; cap at 8 (seed + 7).
    const site: Site = { [`${ORIGIN}/`]: { body: html(...seq(29).map((n) => `/p${n}`)) } };
    for (const n of seq(29)) site[`${ORIGIN}/p${n}`] = { body: html() };

    const out = await runCrawl({ site, config: { maxPages: 8 } });

    expect(out.pages.length).toBe(8);
    expect(out.stats?.pagesFetched).toBe(8);
    expect(out.status).toBe("completed");
  });

  test("maxPages cap is never overshot under concurrency (#268 in-memory counter)", async () => {
    // Same hub, but multiple workers dispatch concurrently near the cap. The
    // pagesCommitted + inFlight reservation must keep the total at exactly the
    // cap — a regression in the counter would store extra pages here.
    const site: Site = { [`${ORIGIN}/`]: { body: html(...seq(40).map((n) => `/p${n}`)) } };
    for (const n of seq(40)) site[`${ORIGIN}/p${n}`] = { body: html() };

    const out = await runCrawl({
      site,
      config: { maxPages: 10, concurrency: 4, perHostConcurrency: 4 },
      yieldEach: true,
    });

    expect(out.pages.length).toBe(10);
    expect(out.stats?.pagesFetched).toBe(10);
    expect(out.status).toBe("completed");
  });

  test("no-hang completion: cycles, self-links, and a broken link still terminate", async () => {
    const site: Site = {
      // self-link, mutual cycle, and a link to an unmapped (404) page.
      [`${ORIGIN}/`]: { body: html("/", "/a", "/missing") },
      [`${ORIGIN}/a`]: { body: html("/", "/a", "/b") },
      [`${ORIGIN}/b`]: { body: html("/a") },
    };
    const out = await runCrawl({ site, config: { maxPages: 100 } });

    // Real pages + the broken link are all accounted for, nothing left pending.
    expect(out.pending).toBe(0);
    expect(out.fetching).toBe(0);
    expect(out.status).toBe("completed");
    expect(out.isRunning).toBe(false);
    // The broken link was attempted exactly once and recorded as a failure.
    expect(out.fetched.filter((u) => u === `${ORIGIN}/missing`).length).toBe(1);
    expect(out.stats?.pagesFailed).toBe(1);
  });

  // #314 — nextDispatch pops a batch (k≈concurrency) per lock acquisition and
  // drains it locally. The batch MUST be clamped to the remaining maxPages
  // reservation so a near-cap pop never overshoots, and buffered entries must
  // dispatch exactly once.
  test("batched pop never overshoots when maxPages is not a multiple of concurrency", async () => {
    // 50 leaves, cap 10, concurrency 4 → batches clamp to the remaining budget
    // (4,4,2). An unclamped batch would fetch 12; we must fetch exactly 10.
    const out = await runCrawl({
      site: hub(50),
      config: { maxPages: 10, concurrency: 4, perHostConcurrency: 4 },
      yieldEach: true,
    });

    expect(out.pages.length).toBe(10);
    expect(out.stats?.pagesFetched).toBe(10);
    // Every fetch produced a stored page — no work done beyond the cap.
    expect(out.fetched.length).toBe(10);
    // No buffered URL was dispatched twice.
    expect(new Set(out.fetched).size).toBe(out.fetched.length);
    expect(out.status).toBe("completed");
  });

  test("concurrency=1 stays serial (batchSize always 1): no overshoot, deterministic order", async () => {
    // batchSize = min(1, budget) = 1 — identical to the old single-pop path.
    // A hub capped below its fan-out fetches exactly the cap, and a re-run
    // yields the identical fetch sequence (serial crawl is fully deterministic).
    const cfg = { maxPages: 6, concurrency: 1, perHostConcurrency: 1 };
    const runA = await runCrawl({ site: hub(20), config: cfg });
    const runB = await runCrawl({ site: hub(20), config: cfg });

    expect(runA.pages.length).toBe(6);
    expect(runA.fetched.length).toBe(6);
    expect(new Set(runA.fetched).size).toBe(6);
    expect(runA.status).toBe("completed");
    expect(runA.fetched).toEqual(runB.fetched);
  });

  test("batched pop clamps the first batch when concurrency exceeds maxPages", async () => {
    // concurrency 8 > cap 3 → the very first batch must clamp to 3, not 8.
    const out = await runCrawl({
      site: hub(20),
      config: { maxPages: 3, concurrency: 8, perHostConcurrency: 8 },
      yieldEach: true,
    });

    expect(out.pages.length).toBe(3);
    expect(out.stats?.pagesFetched).toBe(3);
    expect(out.fetched.length).toBe(3);
    // No buffered URL dispatched twice even when the first batch is clamped.
    expect(new Set(out.fetched).size).toBe(out.fetched.length);
    expect(out.status).toBe("completed");
  });

  test("cap reached mid-buffer: buffered entries dispatch up to the cap, no further", async () => {
    // Seed (1) + a 4-wide buffered batch lands exactly on cap 5: the last
    // committed pages come from buffered entries, and no buffered entry beyond
    // the cap is ever fetched (clamp keeps the reserved set == remaining budget).
    const out = await runCrawl({
      site: hub(20),
      config: { maxPages: 5, concurrency: 5, perHostConcurrency: 5 },
      yieldEach: true,
    });

    expect(out.pages.length).toBe(5);
    expect(out.stats?.pagesFetched).toBe(5);
    expect(out.fetched.length).toBe(5);
    expect(new Set(out.fetched).size).toBe(5);
    expect(out.status).toBe("completed");
  });

  test("batched dispatch drains the full frontier exactly once under concurrency", async () => {
    // Cyclic graph, cap high so the whole frontier drains while batches buffer.
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/a", "/b", "/c") },
      [`${ORIGIN}/a`]: { body: html("/a1", "/a2", "/") },
      [`${ORIGIN}/b`]: { body: html("/b1", "/") },
      [`${ORIGIN}/c`]: { body: html("/") },
      [`${ORIGIN}/a1`]: { body: html("/") },
      [`${ORIGIN}/a2`]: { body: html("/") },
      [`${ORIGIN}/b1`]: { body: html("/") },
    };
    const out = await runCrawl({
      site,
      config: { maxPages: 100, concurrency: 4, perHostConcurrency: 4 },
      yieldEach: true,
    });

    expect(out.pages.map((p) => p.normalizedUrl).sort()).toEqual(Object.keys(site).sort());
    // Buffered entries dispatched exactly once despite the cycles.
    expect(out.fetched.length).toBe(Object.keys(site).length);
    expect(new Set(out.fetched).size).toBe(out.fetched.length);
    expect(out.pending).toBe(0);
    expect(out.fetching).toBe(0);
    expect(out.status).toBe("completed");
    expect(out.isRunning).toBe(false);
  });

  test("a batch popping fewer than k still terminates (frontier smaller than cap)", async () => {
    // Only 3 reachable pages, cap 100, concurrency 8 → popNextUrls returns < k;
    // the loop must drain and complete, not wait forever.
    const site: Site = {
      [`${ORIGIN}/`]: { body: html("/a", "/b") },
      [`${ORIGIN}/a`]: { body: html() },
      [`${ORIGIN}/b`]: { body: html() },
    };
    const out = await runCrawl({
      site,
      config: { maxPages: 100, concurrency: 8, perHostConcurrency: 8 },
      yieldEach: true,
    });

    expect(out.pages.length).toBe(3);
    expect(out.fetched.length).toBe(3);
    expect(out.pending).toBe(0);
    expect(out.fetching).toBe(0);
    expect(out.status).toBe("completed");
  });

  // #802 — drive the crawl loop's REAL fetch-error path (crawler.ts
  // blockedFetch branch): the status guard fails the fetch before any page
  // record exists, and the loop itself increments pagesBlocked. The #797 tests
  // only hand-seeded the stat; these assert the crawler produces it.
  describe("blocked fetch-error path increments pagesBlocked (#792/#802)", () => {
    test("a 403 root fails the fetch and counts as blocked, no page stored", async () => {
      const out = await runCrawl({
        site: { [`${ORIGIN}/`]: { status: 403, body: "Forbidden" } },
      });

      // The guard failed the fetch, so no PageRecord exists (the walled-root shape).
      expect(out.pages.length).toBe(0);
      expect(out.stats?.pagesFailed).toBe(1);
      expect(out.stats?.pagesBlocked).toBe(1);
      // 0 pages + pagesBlocked > 0 is exactly the signal deriveAuditStatus
      // (audit-engine) keys report status "blocked" off — the end-to-end report
      // assertion lives in packages/audit-engine/tests/cloud-audit-status.test.ts
      // (crawler tests can't import audit-engine without a dependency cycle).
      expect(out.status).toBe("completed"); // the crawl loop terminates cleanly
      expect(out.events.some((e) => e.type === "page:failed")).toBe(true);
    });

    test("a challenge-shaped 503 root (Cloudflare interstitial) counts as blocked (#802)", async () => {
      const challengeHtml =
        '<!doctype html><html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">Checking your browser before accessing example.com</div><script src="/cdn-cgi/challenge-platform/orchestrate/jsch/v1"></script></body></html>';
      const out = await runCrawl({
        site: { [`${ORIGIN}/`]: { status: 503, body: challengeHtml } },
      });

      expect(out.pages.length).toBe(0);
      expect(out.stats?.pagesFailed).toBe(1);
      expect(out.stats?.pagesBlocked).toBe(1);
    });

    test("a plain 503 root (no challenge signals) stays a generic failure, not blocked", async () => {
      const out = await runCrawl({
        site: { [`${ORIGIN}/`]: { status: 503, body: "Service temporarily unavailable" } },
      });

      expect(out.pages.length).toBe(0);
      expect(out.stats?.pagesFailed).toBe(1);
      expect(out.stats?.pagesBlocked ?? 0).toBe(0);
    });
  });
});

// 1-based sequence [1..n] — fixture pages are named /p1../pN.
function seq(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

// A root linking to n leaf pages (/p1../pN), each a dead end.
function hub(n: number): Site {
  const site: Site = { [`${ORIGIN}/`]: { body: html(...seq(n).map((i) => `/p${i}`)) } };
  for (const i of seq(n)) site[`${ORIGIN}/p${i}`] = { body: html() };
  return site;
}

describe("crawl-time ParsedPageCache cap (#858)", () => {
  test("retention stops at 25 entries; the crawl itself is unaffected", async () => {
    const cache: ParsedPageCache = new Map();
    const out = await runCrawl({
      site: hub(40),
      config: { maxPages: 41, concurrency: 8, perHostConcurrency: 8 },
      parsedPageCache: cache,
    });

    expect(out.pages.length).toBe(41); // root + 40 leaves all crawled
    expect(cache.size).toBe(25); // retention capped, not the crawl
    // Every retained entry still carries its live DOM for buildSiteContext.
    for (const parsed of cache.values()) expect(parsed.document).not.toBeNull();
  });

  test("small crawls below the cap retain every page (the #267 fast path)", async () => {
    const cache: ParsedPageCache = new Map();
    const out = await runCrawl({
      site: hub(5),
      config: { maxPages: 10, concurrency: 8, perHostConcurrency: 8 },
      parsedPageCache: cache,
    });

    expect(out.pages.length).toBe(6);
    expect(cache.size).toBe(6);
  });
});
