// Crawl and frontier status writes check the transition table (#1659).
//
// The legal edges below are what the crawler and the CLI do today; they passed on the unguarded
// storage before the guard existed. The illegal edges are the bug: `stop()` writing `paused` over a
// crawl that already finished, a frontier entry moving to done/failed/skipped without having been
// reserved, and any other write the table does not list.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCrawler } from "../src/core/crawler";
import type { CrawlerConfig, CrawlerEvent } from "../src/core/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { CrawlMetadata, CrawlStatus, FrontierRecord, FrontierStatus } from "../src/storage/types";

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);
const STATS = { pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0, linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sq-transitions-1659-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function crawlAt(status: CrawlStatus): Promise<{ s: SQLiteStorage; id: string }> {
  const s = new SQLiteStorage(join(dir, "project.db"));
  await run(s.init());
  const id = await run(
    s.createCrawl({ baseUrl: "https://e.test", startedAt: 1, status: "running", config: {} as CrawlMetadata["config"], stats: STATS } as Omit<CrawlMetadata, "id">),
  );
  // Reach `status` along the legal path the crawler takes.
  const path: Record<CrawlStatus, CrawlStatus[]> = {
    running: [],
    paused: ["paused"],
    completed: ["completed"],
    stopped: ["stopped"],
    crawled: ["completed", "crawled"],
    analyzed: ["completed", "crawled", "analyzed"],
    failed: ["failed"],
  };
  for (const step of path[status]) await run(s.updateCrawl(id, { status: step }));
  expect((await run(s.getCrawl(id)))?.status).toBe(status);
  return { s, id };
}

const statusOf = async (s: SQLiteStorage, id: string) => (await run(s.getCrawl(id)))?.status;

describe("crawl status: the edges the crawler and the CLI use stay legal", () => {
  const legal: Array<[CrawlStatus, CrawlStatus]> = [
    ["running", "paused"], // stop() while crawling
    ["paused", "running"], // resume
    ["running", "completed"], // the crawl drained
    ["running", "stopped"], // the crawl-phase backstop
    ["paused", "completed"], // stop() wrote paused, the loop then finished
    ["paused", "stopped"],
    ["completed", "crawled"], // the controller after the crawl
    ["stopped", "crawled"],
    ["crawled", "analyzed"], // the rules phase
    ["analyzed", "analyzed"], // a re-analysis
    ["completed", "analyzed"], // `squirrel analyze` on an older crawl
    ["completed", "running"], // a re-crawl restarts the crawl row
    ["analyzed", "running"],
    ["stopped", "running"], // resume of a backstop cut
    ["running", "failed"],
  ];
  for (const [from, to] of legal) {
    test(`${from} -> ${to}`, async () => {
      const { s, id } = await crawlAt(from);
      await run(s.updateCrawl(id, { status: to }));
      expect(await statusOf(s, id)).toBe(to);
      s.close?.();
    });
  }

  test("a write that carries a status and other columns applies them together when legal", async () => {
    const { s, id } = await crawlAt("running");
    await run(s.updateCrawl(id, { status: "completed", completedAt: 99 }));
    const crawl = await run(s.getCrawl(id));
    expect([crawl?.status, crawl?.completedAt]).toEqual(["completed", 99]);
    s.close?.();
  });

  test("a write with no status is never guarded", async () => {
    const { s, id } = await crawlAt("analyzed");
    await run(s.updateCrawl(id, { stats: { ...STATS, pagesFetched: 4 } }));
    expect((await run(s.getCrawl(id)))?.stats.pagesFetched).toBe(4);
    expect(await statusOf(s, id)).toBe("analyzed");
    s.close?.();
  });
});

describe("crawl status: an illegal write is a no-op that does not throw", () => {
  const illegal: Array<[CrawlStatus, CrawlStatus]> = [
    ["completed", "paused"], // the reported bug: stop() after completion
    ["stopped", "paused"],
    ["crawled", "paused"],
    ["analyzed", "paused"],
    ["failed", "paused"],
    ["crawled", "completed"],
    ["analyzed", "completed"],
    ["analyzed", "stopped"],
    ["failed", "completed"],
    ["failed", "crawled"],
    ["analyzed", "crawled"],
    ["completed", "failed"],
    ["analyzed", "failed"],
  ];
  for (const [from, to] of illegal) {
    test(`${from} -> ${to} leaves ${from}`, async () => {
      const { s, id } = await crawlAt(from);
      await run(s.updateCrawl(id, { status: to, completedAt: 12345 }));
      const crawl = await run(s.getCrawl(id));
      expect(crawl?.status).toBe(from);
      // The whole write is a no-op: the other columns it carried are not applied either.
      expect(crawl?.completedAt).not.toBe(12345);
      s.close?.();
    });
  }

  test("a refused write is reported to the hook with both statuses, and never throws", async () => {
    const { s, id } = await crawlAt("completed");
    const seen: Array<{ kind: string; from: string; to: string }> = [];
    s.onIgnoredTransition = (info) => seen.push(info);
    await run(s.updateCrawl(id, { status: "paused" }));
    expect(seen).toEqual([{ kind: "crawl", id, from: "completed", to: "paused" }]);
    s.close?.();
  });

  test("a legal write is not reported", async () => {
    const { s, id } = await crawlAt("running");
    const seen: unknown[] = [];
    s.onIgnoredTransition = (info) => seen.push(info);
    await run(s.updateCrawl(id, { status: "paused" }));
    expect(seen).toEqual([]);
    s.close?.();
  });

  test("an unknown crawl id is still a quiet no-op", async () => {
    const { s } = await crawlAt("running");
    await run(s.updateCrawl("missing", { status: "paused" }));
    s.close?.();
  });
});

const entry = (url: string, status: FrontierStatus): FrontierRecord => ({
  normalizedUrl: url, rawUrl: url, depth: 1, priority: 0, status, source: "discovered", enqueuedAt: 1, retryCount: 0,
});

async function frontierAt(status: FrontierStatus): Promise<{ s: SQLiteStorage; id: string }> {
  const { s, id } = await crawlAt("running");
  await run(s.upsertFrontier(id, entry("https://e.test/a", status)));
  return { s, id };
}
const frontierStatus = async (s: SQLiteStorage, id: string) => (await run(s.getFrontierEntry(id, "https://e.test/a")))?.status;

describe("frontier status", () => {
  test("pending -> fetching (popNextUrl) -> done, failed or skipped", async () => {
    for (const to of ["done", "failed", "skipped"] as const) {
      const { s, id } = await frontierAt("pending");
      const popped = await run(s.popNextUrl(id));
      expect(popped?.status).toBe("fetching");
      await run(s.updateFrontierStatus(id, "https://e.test/a", to, to === "failed" ? "boom" : undefined));
      expect(await frontierStatus(s, id)).toBe(to);
      s.close?.();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "sq-transitions-1659-"));
    }
  });

  test("resetStaleFetching re-queues a fetching entry on resume, and only that", async () => {
    const { s, id } = await frontierAt("fetching");
    await run(s.upsertFrontier(id, { ...entry("https://e.test/done", "done") }));
    await run(s.upsertFrontier(id, { ...entry("https://e.test/failed", "failed") }));
    expect(await run(s.resetStaleFetching(id))).toBe(1);
    expect(await frontierStatus(s, id)).toBe("pending");
    expect((await run(s.getFrontierEntry(id, "https://e.test/done")))?.status).toBe("done");
    expect((await run(s.getFrontierEntry(id, "https://e.test/failed")))?.status).toBe("failed");
    s.close?.();
  });

  test("a pending entry does not move to done, failed or skipped without being reserved", async () => {
    for (const to of ["done", "failed", "skipped"] as const) {
      const { s, id } = await frontierAt("pending");
      await run(s.updateFrontierStatus(id, "https://e.test/a", to, "x"));
      expect(await frontierStatus(s, id), to).toBe("pending");
      s.close?.();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "sq-transitions-1659-"));
    }
  });

  test("a refused frontier write is reported and never throws", async () => {
    const { s, id } = await frontierAt("pending");
    const seen: Array<{ kind: string; from: string; to: string }> = [];
    s.onIgnoredTransition = (info) => seen.push(info);
    await run(s.updateFrontierStatus(id, "https://e.test/a", "done"));
    expect(seen).toEqual([{ kind: "frontier", id: "https://e.test/a", from: "pending", to: "done" }]);
    s.close?.();
  });

  test("a finished entry is not rewritten by a late worker", async () => {
    for (const from of ["done", "failed", "skipped"] as const) {
      const { s, id } = await frontierAt(from);
      await run(s.updateFrontierStatus(id, "https://e.test/a", from === "done" ? "failed" : "done", "late"));
      expect(await frontierStatus(s, id), from).toBe(from);
      s.close?.();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "sq-transitions-1659-"));
    }
  });
});

// --- stop() after the crawl finished, through the real crawler -------------------------------

const ORIGIN = "https://example.com";
const HEADERS = {
  contentType: "text/html", contentEncoding: null, cacheControl: null, expires: null, vary: null, etag: null, server: null,
  lastModified: null, link: null, serverTiming: null, age: null, xCache: null, cfCacheStatus: null, xVercelCache: null,
  altSvc: null, acceptRanges: null,
};
const SECURITY = { hsts: null, csp: null, xFrameOptions: null, xContentTypeOptions: null, referrerPolicy: null, permissionsPolicy: null, xRobotsTag: null };
const fetcher: CrawlFetcher = (url) =>
  Effect.gen(function* () {
    const body = `<!doctype html><html><body><a href="${ORIGIN}/a">a</a></body></html>`;
    yield* applyStatusGuards(url, 200, new Headers(), body);
    return {
      url, finalUrl: url, status: 200, loadTime: 1, ttfb: 1, downloadTime: 1, headers: HEADERS, securityHeaders: SECURITY,
      contentType: "text/html", body, sizeBytes: body.length,
      redirectChain: { sourceUrl: url, finalUrl: url, hops: [], chainLength: 0, isLoop: false, endsInError: false, httpsToHttp: false, httpToHttps: false },
      fetcherId: undefined, fallbackReason: undefined,
    };
  });

describe("stop() after the crawl reached a terminal status (#1659)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const res = new Response("", { status: 404, headers: { "content-type": "text/plain" } });
      Object.defineProperty(res, "url", { value: url, configurable: true });
      return Promise.resolve(res);
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a completed crawl stays completed when stop() is called afterwards", async () => {
    const config: Partial<CrawlerConfig> = {
      concurrency: 1, perHostConcurrency: 1, delayMs: 0, perHostDelayMs: 0, timeoutMs: 1000, userAgent: "test",
      respectRobots: false, incremental: false, useCacheControl: false, breadthFirst: false, disableLinkDiscovery: false,
      coverageMode: "full",
    };
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const crawler = yield* createCrawler({ fetcher, config });
        const events: CrawlerEvent[] = [];
        const collector = yield* Stream.runForEach(
          crawler.events.pipe(Stream.takeUntil((e) => e.type === "completed")),
          (e) => Effect.sync(() => void events.push(e)),
        ).pipe(Effect.fork);
        yield* Effect.yieldNow();
        const crawlId = yield* crawler.start(ORIGIN);
        yield* Fiber.join(collector).pipe(Effect.timeout(Duration.seconds(5)), Effect.ignore);
        yield* Fiber.interrupt(collector);
        const before = (yield* crawler.storage.getCrawl(crawlId))?.status;
        yield* crawler.stop();
        const after = (yield* crawler.storage.getCrawl(crawlId))?.status;
        return { before, after };
      }) as Effect.Effect<{ before: string | undefined; after: string | undefined }, never, never>,
    );
    expect(out.before).toBe("completed");
    expect(out.after).toBe("completed");
  }, 30_000);
});
