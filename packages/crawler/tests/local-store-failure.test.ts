// #403: a page the local store refuses. A store that can never be written
// (read-only, not a database, disk full) ends the crawl with its own error
// instead of dropping every page one by one; one that may recover (locked by
// another process) still drops the page, but an audit that stores nothing says
// why instead of a bare "No pages were crawled".

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Either } from "effect";

import { auditFailureReasonText } from "@squirrelscan/core-contracts/failure-reason";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";
import type { CrawlStats, CrawlStorage } from "../src/storage/types";
import { StorageError, isPermanentStorageError } from "../src/storage/types";
import { applyStatusGuards, type CrawlFetcher } from "../src/fetcher";
import type { CrawlerConfig } from "../src/core/types";

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

// A root linking to 20 leaves, so a crawl that keeps going after the first
// refused page would fetch far more than the worker count.
function hubSite(n: number): Record<string, string> {
  const anchors = Array.from({ length: n }, (_, i) => `<a href="${ORIGIN}/p${i}">p${i}</a>`).join("");
  const site: Record<string, string> = {
    [`${ORIGIN}/`]: `<!doctype html><html><body>${anchors}</body></html>`,
  };
  for (let i = 0; i < n; i++) site[`${ORIGIN}/p${i}`] = "<!doctype html><html><body></body></html>";
  return site;
}

function fixtureFetcher(site: Record<string, string>, onFetch: () => void): CrawlFetcher {
  return (url) =>
    Effect.gen(function* () {
      onFetch();
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

// Real in-memory storage whose page writes fail with `cause` once `okWrites`
// have gone through, the way the CLI's content store fails inside upsertPage.
function refusingStorage(base: CrawlStorage, cause: string, okWrites: number): CrawlStorage {
  let writes = 0;
  return new Proxy(base, {
    get(target, prop, recv) {
      if (prop === "upsertPage") {
        return (...args: Parameters<CrawlStorage["upsertPage"]>) =>
          writes++ < okWrites
            ? target.upsertPage(...args)
            : Effect.fail(StorageError.write(new Error(cause)));
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

const CONFIG: Partial<CrawlerConfig> = {
  concurrency: 2, perHostConcurrency: 1, delayMs: 0, perHostDelayMs: 0, timeoutMs: 1000,
  userAgent: "test", respectRobots: false, incremental: false,
  useCacheControl: false, breadthFirst: false, disableLinkDiscovery: false,
  coverageMode: "full", maxPages: 100,
};

interface Outcome {
  result: Either.Either<string, unknown>;
  fetches: number;
  pageCount: number;
  stats: CrawlStats | null;
}

function crawlWithRefusingStore(cause: string, okWrites = 0): Promise<Outcome> {
  // robots/sitemap/discovery probes go through global fetch: answer them 404.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const res = new Response("", { status: 404, headers: { "content-type": "text/plain" } });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return Promise.resolve(res);
  }) as typeof globalThis.fetch;

  const program = Effect.gen(function* () {
    const base = yield* createTestStorage();
    let fetches = 0;
    const crawler = yield* createCrawler({
      fetcher: fixtureFetcher(hubSite(20), () => fetches++),
      storage: refusingStorage(base, cause, okWrites),
      config: CONFIG,
    });
    const result = yield* crawler
      .start(ORIGIN)
      .pipe(Effect.timeout(Duration.seconds(10)), Effect.either);
    const crawlId = crawler.currentCrawlId!;
    const pageCount = yield* base.getPageCount(crawlId).pipe(Effect.orElseSucceed(() => -1));
    const stats = yield* base.getStats(crawlId).pipe(Effect.orElseSucceed(() => null));
    return { result, fetches, pageCount, stats } satisfies Outcome;
  });

  return Effect.runPromise(program).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe("isPermanentStorageError", () => {
  test("names the failures no retry fixes, and recognizes them through a FiberFailure", async () => {
    for (const cause of [
      "attempt to write a readonly database",
      "unable to open database file",
      "file is not a database",
      "database disk image is malformed",
      "database or disk is full",
      "disk I/O error",
    ]) {
      const error = StorageError.write(new Error(cause));
      expect(isPermanentStorageError(error)).toBe(true);
      const thrown = await Effect.runPromise(Effect.fail(error)).catch((e: unknown) => e);
      expect(isPermanentStorageError(thrown)).toBe(true);
    }
    expect(isPermanentStorageError(StorageError.write(new Error("database is locked")))).toBe(false);
    expect(isPermanentStorageError(new Error("attempt to write a readonly database"))).toBe(false);
  });
});

describe("a page the local store refuses (#403)", () => {
  test("a read-only store ends the crawl with its error instead of dropping every page", async () => {
    const out = await crawlWithRefusingStore("attempt to write a readonly database");

    expect(Either.isLeft(out.result)).toBe(true);
    if (Either.isLeft(out.result)) {
      expect(isPermanentStorageError(out.result.left)).toBe(true);
    }
    expect(out.pageCount).toBe(0);
    // Stops at the first refused page per worker, not after the whole hub.
    expect(out.fetches).toBeLessThanOrEqual(CONFIG.concurrency! + 1);
  });

  test("a store that turns read-only mid-crawl fails the crawl, not a smaller audit", async () => {
    const out = await crawlWithRefusingStore("attempt to write a readonly database", 3);

    expect(Either.isLeft(out.result)).toBe(true);
    expect(out.pageCount).toBe(3);
    expect(out.fetches).toBeLessThan(21);
  });

  test("a locked store drops pages, and the empty crawl records why", async () => {
    const out = await crawlWithRefusingStore("database is locked");

    expect(Either.isRight(out.result)).toBe(true);
    expect(out.pageCount).toBe(0);
    const failure = out.stats?.rootFailure;
    expect(failure?.code).toBe("unknown");
    expect(failure?.host).toBe("example.com");
    expect(failure?.detail).toBe(
      "a page could not be saved to the local store (it was locked by another squirrel process)",
    );
    expect(auditFailureReasonText(failure!)).toBe(
      "No pages were crawled from example.com: a page could not be saved to the local store (it was locked by another squirrel process)",
    );
  });
});
