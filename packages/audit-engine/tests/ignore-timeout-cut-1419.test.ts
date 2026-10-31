// A rules phase cut after an `[[ignore]]` matcher exhausts its work budget must
// retain the timeout index even though no RuleExecutionResult is returned (#1419).

import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord, ResponseHeaders, SecurityHeaders } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { runStreamingRules, type PreFetchedAssets } from "../src/adapter";

const BASE = "https://example.com";
const COOKIE_RULE = "security/cookie-flags";

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const HEADERS: ResponseHeaders = {
  contentType: "text/html",
  contentEncoding: null,
  cacheControl: null,
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
  setCookie: Array.from({ length: 20 }, (_, i) => `${"q".repeat(2040)}${i}=1; Path=/`).join("\n"),
};

const SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function page(): PageRecord {
  const html =
    '<!doctype html><html lang="en"><head><title>Cookies</title></head><body><h1>Cookies</h1></body></html>';
  return {
    url: `${BASE}/`,
    normalizedUrl: `${BASE}/`,
    finalUrl: `${BASE}/`,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: Buffer.byteLength(html),
    loadTimeMs: 1,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "cookies",
    html,
    parsedData: null,
    headers: HEADERS,
    securityHeaders: SECURITY_HEADERS,
  } as PageRecord;
}

const CONFIG = {
  rule_options: {},
  rules: { enable: [COOKIE_RULE] },
  ignore: [
    {
      rule: COOKIE_RULE,
      items: Array.from({ length: 100 }, (_, i) => `glob:*never-${i}`),
    },
  ],
} as unknown as Config;

describe("an ignore timeout before a rules-phase cut (#1419)", () => {
  test("the callback retains the entry index when timeoutOption cuts the result", async () => {
    const storage = new SQLiteStorage(":memory:");
    const observed: number[] = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* storage.init();
        const crawlId = yield* storage.createCrawl({
          baseUrl: BASE,
          seedUrl: `${BASE}/`,
          startedAt: Date.now(),
          status: "completed",
          config: {} as never,
          stats: {
            pagesTotal: 1,
            pagesFetched: 1,
            pagesFailed: 0,
            pagesSkipped: 0,
            pagesUnchanged: 0,
            linksTotal: 0,
            imagesTotal: 0,
            bytesTotal: 0,
            avgLoadTimeMs: 1,
          },
        } as never);
        yield* storage.upsertPage(crawlId, page());

        return yield* Effect.timeoutOption(
          runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, {
            batchSize: 1,
            pageLoopHooks: { yieldEveryMs: 1 },
            onIgnoreTimeout: (entry) => {
              observed.push(entry);
              // Cross the deadline only after the timeout has been observed. The
              // cooperative page-loop yield then lets timeoutOption cut the phase.
              Bun.sleepSync(1100);
            },
          }),
          Duration.millis(1000),
        );
      }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
    );

    expect(result._tag).toBe("None");
    expect(observed).toEqual([0]);
  }, 10_000);
});
