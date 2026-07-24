// #923 — stop() (fired by the crawl-phase wall-clock backstop) must be a HARD
// cap: a worker wedged inside an in-flight fetch is only re-checked at its
// loop top, so before this fix stop() left it running to the ~180s per-URL
// watchdog (urlTimeoutMs = max(120s, timeoutMs*6)) — a second multiple of the
// budget. Now stop() arms a bounded grace window after which the crawl pool is
// interrupted, so a stuck fetch can't extend the crawl past cap + grace.

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";

import { createCrawler } from "../src/core/crawler";
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

// A fetcher whose fetch never returns on its own. `mode` selects how it hangs:
//  - "never": an interruptible Effect (Effect.never)
//  - "promise": an un-abortable native promise (the #598 footgun) — proves the
//    fiber interrupt preempts the suspended effect even though the underlying
//    promise can't be cancelled.
// onInterrupt records that the in-flight op was actually interrupted (not just
// abandoned by a returning-early loop).
function wedgedFetcher(mode: "never" | "promise", onInterrupt: () => void): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      yield* applyStatusGuards(url, 200, new Headers(), "<html></html>");
      if (mode === "never") {
        yield* Effect.never;
      } else {
        yield* Effect.promise(() => new Promise<void>(() => {}));
      }
      // Unreachable — present only to satisfy the return type.
      return {
        url, finalUrl: url, status: 200, loadTime: 1, ttfb: 1, downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html" },
        securityHeaders: EMPTY_SECURITY_HEADERS, contentType: "text/html",
        body: "<html></html>", sizeBytes: 13,
        redirectChain: { sourceUrl: url, finalUrl: url, hops: [], chainLength: 0, isLoop: false, endsInError: false, httpsToHttp: false, httpToHttps: false },
        fetcherId: undefined, fallbackReason: undefined,
      };
    }).pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt)));
}

function healthyFetcher(site: Record<string, string>): CrawlFetcher {
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

// Serves the root (linking to `childUrl`) normally but hangs forever on the
// child — so the crawl stores the root, discovers the child, then wedges
// mid-frontier when it tries to fetch it. Produces a genuine "stopped" crawl
// with a live frontier to resume.
function serveRootHangChild(childUrl: string, onInterrupt: () => void): CrawlFetcher {
  const rootBody = `<!doctype html><html><body><a href="${childUrl}">a</a></body></html>`;
  return (url) =>
    Effect.gen(function* () {
      if (url === childUrl) {
        yield* applyStatusGuards(url, 200, new Headers(), "<html></html>");
        yield* Effect.never;
      }
      const body = url === `${ORIGIN}/` ? rootBody : "";
      const status = url === `${ORIGIN}/` ? 200 : 404;
      yield* applyStatusGuards(url, status, new Headers(), body);
      return {
        url, finalUrl: url, status, loadTime: 1, ttfb: 1, downloadTime: 1,
        headers: { ...EMPTY_RESPONSE_HEADERS, contentType: "text/html" },
        securityHeaders: EMPTY_SECURITY_HEADERS, contentType: "text/html",
        body, sizeBytes: body.length,
        redirectChain: { sourceUrl: url, finalUrl: url, hops: [], chainLength: 0, isLoop: false, endsInError: false, httpsToHttp: false, httpToHttps: false },
        fetcherId: undefined, fallbackReason: undefined,
      };
    }).pipe(Effect.onInterrupt(() => Effect.sync(onInterrupt)));
}

// A short per-fetch timeout so the per-URL watchdog ceiling (max(120s,
// timeoutMs*6)) is a clear 120s — any return within a couple seconds proves the
// grace-interrupt, not the watchdog, ended the crawl.
const CAP_MS = 200;
const GRACE_MS = 300;
const WATCHDOG_FLOOR_MS = 120_000;

const CONFIG: Partial<CrawlerConfig> = {
  concurrency: 1, perHostConcurrency: 1, delayMs: 0, perHostDelayMs: 0,
  timeoutMs: 1000, userAgent: "test", respectRobots: false, incremental: false,
  useCacheControl: false, breadthFirst: false, disableLinkDiscovery: false,
  coverageMode: "full", maxPages: 100, stopGraceMs: GRACE_MS,
};

function stubPreamble(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const res = new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return Promise.resolve(res);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

interface StopOutcome {
  returnedCleanly: boolean;
  sinceStopMs: number;
  interrupted: boolean;
  isRunning: boolean;
  status: string | undefined;
}

function runWedgedThenStop(mode: "never" | "promise"): Promise<StopOutcome> {
  const restore = stubPreamble();
  let interrupted = false;

  const program = Effect.gen(function* () {
    const crawler = yield* createCrawler({
      fetcher: wedgedFetcher(mode, () => {
        interrupted = true;
      }),
      config: CONFIG,
    });
    const startFiber = yield* crawler.start(ORIGIN).pipe(Effect.either, Effect.fork);

    // Simulate the backstop firing after CAP_MS, then stop().
    yield* Effect.sleep(Duration.millis(CAP_MS));
    const stopAt = Date.now();
    yield* crawler.stop();

    // Bounded well under the 120s watchdog: if the crawl only returns via the
    // watchdog this join times out and returnedCleanly is false.
    const res = yield* Fiber.join(startFiber).pipe(Effect.timeout(Duration.seconds(10)), Effect.either);
    const sinceStopMs = Date.now() - stopAt;

    const crawlId = crawler.currentCrawlId;
    const crawl = crawlId ? yield* crawler.storage.getCrawl(crawlId) : undefined;

    return {
      returnedCleanly: res._tag === "Right",
      sinceStopMs,
      interrupted,
      isRunning: crawler.isRunning,
      status: crawl?.status,
    } satisfies StopOutcome;
  });

  return Effect.runPromise(program).finally(restore);
}

describe("crawl-phase backstop stop() hard cap (#923)", () => {
  test("interruptible wedged fetch: crawl returns within cap + grace, not the ~180s watchdog", async () => {
    const out = await runWedgedThenStop("never");

    expect(out.returnedCleanly).toBe(true);
    expect(out.interrupted).toBe(true); // the in-flight op was actually interrupted
    expect(out.isRunning).toBe(false);
    // ≈ grace, and unambiguously below the per-URL watchdog floor.
    expect(out.sinceStopMs).toBeLessThan(GRACE_MS + 3_000);
    expect(out.sinceStopMs).toBeLessThan(WATCHDOG_FLOOR_MS);
    // The loop still reaches its terminal tail (the "completed" event is what
    // subscribers await to know it exited), but persists status "stopped" — its
    // own terminal state for a backstop hard-interrupt (#969) so a direct
    // CrawlStorage consumer can't read a partial crawl as "completed". The two
    // backstop callers still overwrite this from their crawlPhaseStopped flag
    // afterwards (CLI → "crawled"; cloud → "running"), so their behavior is
    // unchanged; this asserts the crawler's own contract.
    expect(out.status).toBe("stopped");
  });

  test("un-abortable native promise (the #598 footgun) is still preempted by the fiber interrupt", async () => {
    const out = await runWedgedThenStop("promise");

    expect(out.returnedCleanly).toBe(true);
    expect(out.interrupted).toBe(true);
    expect(out.isRunning).toBe(false);
    expect(out.sinceStopMs).toBeLessThan(GRACE_MS + 3_000);
    expect(out.sinceStopMs).toBeLessThan(WATCHDOG_FLOOR_MS);
    expect(out.status).toBe("stopped");
  });

  test("normal (non-wedged) crawl completes on its own — grace window adds no latency", async () => {
    const restore = stubPreamble();
    const site: Record<string, string> = {
      [`${ORIGIN}/`]: `<!doctype html><html><body><a href="${ORIGIN}/a">a</a></body></html>`,
      [`${ORIGIN}/a`]: "<!doctype html><html><body></body></html>",
    };

    // A deliberately huge grace window: if the pool→stopGuard race ever gated
    // normal completion on the grace timer, this crawl would take ~30s. It
    // finishes in milliseconds because raceFirst returns the instant the pool
    // completes, interrupting the (never-signalled) stop guard.
    const program = Effect.gen(function* () {
      const crawler = yield* createCrawler({
        fetcher: healthyFetcher(site),
        config: { ...CONFIG, stopGraceMs: 30_000 },
      });
      let completed = false;
      const collector = yield* Stream.runForEach(
        crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
        (e: CrawlerEvent) => Effect.sync(() => { if (e.type === "completed") completed = true; }),
      ).pipe(Effect.fork);
      yield* Effect.yieldNow();

      const startedAt = Date.now();
      const crawlId = yield* crawler.start(ORIGIN);
      const elapsed = Date.now() - startedAt;

      yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
      yield* Fiber.interrupt(collector);

      const pages = yield* crawler.storage.getPages(crawlId);
      const crawl = yield* crawler.storage.getCrawl(crawlId);
      return { elapsed, completed, pageCount: pages.length, status: crawl?.status };
    });

    const out = await Effect.runPromise(program).finally(restore);

    // Both pages crawled, marked completed — and start() returned promptly
    // (the pool won the race long before the grace window mattered).
    expect(out.pageCount).toBe(2);
    expect(out.completed).toBe(true);
    expect(out.status).toBe("completed");
    // Orders of magnitude below the 30s grace — proves grace adds no latency.
    expect(out.elapsed).toBeLessThan(5_000);
  });

  test("resume continues a 'stopped' crawl to completion (#969)", async () => {
    const restore = stubPreamble();
    const childUrl = `${ORIGIN}/a`;
    let interrupted = false;

    const program = Effect.gen(function* () {
      // 1. Crawl serves the root (→ discovers /a) then wedges on /a; the
      //    backstop stop() cuts it short mid-frontier → status "stopped".
      const crawlerA = yield* createCrawler({
        fetcher: serveRootHangChild(childUrl, () => {
          interrupted = true;
        }),
        config: CONFIG,
      });
      const startFiber = yield* crawlerA
        .start(ORIGIN)
        .pipe(Effect.either, Effect.fork);
      yield* Effect.sleep(Duration.millis(CAP_MS));
      yield* crawlerA.stop();
      yield* Fiber.join(startFiber).pipe(
        Effect.timeout(Duration.seconds(10)),
        Effect.either,
      );

      const crawlId = crawlerA.currentCrawlId;
      if (!crawlId) throw new Error("crawl never started");
      const stopped = yield* crawlerA.storage.getCrawl(crawlId);
      const pagesAfterStop = yield* crawlerA.storage.getPages(crawlId);

      // 2. Resume on the SAME storage with a healthy fetcher for /a. The
      //    orphaned "fetching" entry is reset to pending and drained → completed.
      const site: Record<string, string> = {
        [`${ORIGIN}/`]: `<!doctype html><html><body><a href="${childUrl}">a</a></body></html>`,
        [childUrl]: "<!doctype html><html><body></body></html>",
      };
      const crawlerB = yield* createCrawler({
        storage: crawlerA.storage,
        fetcher: healthyFetcher(site),
        config: CONFIG,
      });
      yield* crawlerB.resumeFromStorage(crawlId);

      const resumed = yield* crawlerB.storage.getCrawl(crawlId);
      const pagesAfterResume = yield* crawlerB.storage.getPages(crawlId);

      return {
        interrupted,
        stoppedStatus: stopped?.status,
        pagesAfterStop: pagesAfterStop.length,
        resumedStatus: resumed?.status,
        pagesAfterResume: pagesAfterResume.length,
      };
    });

    const out = await Effect.runPromise(program).finally(restore);

    expect(out.interrupted).toBe(true);
    // The interrupted crawl persists "stopped", not "completed".
    expect(out.stoppedStatus).toBe("stopped");
    expect(out.pagesAfterStop).toBe(1); // only the root landed before the wedge
    // Resume drains the leftover frontier (the reset /a) and finishes cleanly.
    expect(out.resumedStatus).toBe("completed");
    expect(out.pagesAfterResume).toBe(2); // root + /a
  });
});
