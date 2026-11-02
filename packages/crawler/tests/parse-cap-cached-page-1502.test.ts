// #1502: the `--max-duration` parse cap (#1332) also holds when a cached page is reused. A page over the cap is stored
// but never parsed when it is fetched, so it carries no parsed links; reusing it from cache used to fall back to parsing
// its HTML, which is the cost the cap exists to bound. Drives a real two-pass incremental crawl: pass 1 stores the
// page under a cap it exceeds, pass 2 reuses it from cache under the cap being tested. Synthetic host.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";
const OFF_MAP = `${ORIGIN}/off-map`;

const HOME = `<!doctype html><html><head><title>t</title></head><body><a href="${OFF_MAP}">off</a><p>${"x".repeat(2_000)}</p></body></html>`;
const HOME_BYTES = Buffer.byteLength(HOME);

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps the stored page fresh on pass 2, so it is reused unfetched.
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" },
    body,
    timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [{ url, statusCode: 200, type: "http" as const }],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  };
}

function fetcherFor(fetched: string[], home: string = HOME): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      return mockResponse(req.url, req.url === `${ORIGIN}/` ? home : "<!doctype html><title>l</title><p>leaf</p>");
    },
  };
}

const emptyStats = {
  pagesTotal: 0,
  pagesFetched: 0,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

const baseConfig = {
  delayMs: 0,
  timeoutMs: 5000,
  userAgent: "test",
  followRedirects: true,
  respectRobots: false,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
  breadthFirst: false,
  coverageMode: "full" as const,
  allowedDomains: ["h.invalid"],
  maxPages: 50,
};

async function crawlRecord(storage: CrawlStorage, config: Record<string, unknown>): Promise<string> {
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config,
      stats: emptyStats,
    }),
  );
  await Effect.runPromise(
    storage.upsertFrontier(crawlId, {
      normalizedUrl: `${ORIGIN}/`,
      rawUrl: `${ORIGIN}/`,
      depth: 0,
      priority: 1,
      status: "pending" as const,
      source: "seed" as const,
      enqueuedAt: Date.now(),
      retryCount: 0,
    }),
  );
  return crawlId;
}

/**
 * Pass 1 fetches the home page under a cap of 1 byte (stored, never parsed: no parsed links). Pass 2 reuses it from
 * cache under `cap`. `encodedSize` rewrites the stored size to a small number, as a gzip body would have recorded.
 */
async function reuseUnderCap(cap: number | undefined, encodedSize?: number, home: string = HOME) {
  const storage = await Effect.runPromise(createTestStorage());
  const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false, maxParseBytes: 1 };
  const crawlId1 = await crawlRecord(storage, cfg1);
  const crawler1 = await Effect.runPromise(createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([], home) }, storage }));
  await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
  const stored = await Effect.runPromise(storage.getPage(crawlId1, `${ORIGIN}/`));
  expect(stored?.parsedData ?? null).toBeNull(); // nothing parsed on pass 1
  if (encodedSize !== undefined && stored) {
    await Effect.runPromise(storage.upsertPage(crawlId1, { ...stored, sizeBytes: encodedSize }));
  }

  const fetched: string[] = [];
  const cfg2 = {
    ...baseConfig,
    incremental: true,
    useCacheControl: true,
    maxStalenessSeconds: 999_999,
    ...(cap !== undefined ? { maxParseBytes: cap } : {}),
  };
  const crawlId2 = await crawlRecord(storage, cfg2);
  const crawler2 = await Effect.runPromise(createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched, home) }, storage }));
  await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
  const frontier = (await Effect.runPromise(storage.getAllFrontierEntries(crawlId2))).map((e) => e.normalizedUrl);
  const stats = await Effect.runPromise(storage.getStats(crawlId2));
  await Effect.runPromise(storage.close());
  return { fetched, frontier, unchanged: stats?.pagesUnchanged ?? 0 };
}

describe("a reused cached page honours the parse cap (#1502)", () => {
  test("a cached page over the cap is reused but not parsed: its links are not discovered", async () => {
    const r = await reuseUnderCap(HOME_BYTES - 1);
    expect(r.fetched).toEqual([]); // reused from cache, not fetched
    expect(r.unchanged).toBeGreaterThan(0);
    expect(r.frontier).not.toContain(OFF_MAP);
  }, 30_000);

  test("boundary: a cached page of exactly the cap is parsed, one byte over is not", async () => {
    expect((await reuseUnderCap(HOME_BYTES)).frontier).toContain(OFF_MAP);
    expect((await reuseUnderCap(HOME_BYTES - 1)).frontier).not.toContain(OFF_MAP);
  }, 60_000);

  test("a small encoded size does not hide a body that decodes over the cap (a gzip page)", async () => {
    const r = await reuseUnderCap(HOME_BYTES - 1, 100);
    expect(r.frontier).not.toContain(OFF_MAP);
  }, 30_000);

  test("the size is counted in bytes: a multi-byte page parses at exactly its byte size and not one byte under, though its character count is far under", async () => {
    const cjk = `<!doctype html><html><head><title>t</title></head><body><a href="${OFF_MAP}">off</a><p>${"中".repeat(1_500)}</p></body></html>`;
    const bytes = Buffer.byteLength(cjk);
    expect(cjk.length).toBeLessThan(bytes - 2_000);
    expect((await reuseUnderCap(bytes, undefined, cjk)).frontier).toContain(OFF_MAP);
    expect((await reuseUnderCap(bytes - 1, undefined, cjk)).frontier).not.toContain(OFF_MAP);
    // over the cap in bytes and under it in characters: an UTF-16 length comparison would parse it
    expect((await reuseUnderCap(cjk.length + 100, undefined, cjk)).frontier).not.toContain(OFF_MAP);
    // the same when the recorded (encoded) size is small, as a gzip page's is: only the html's own bytes can decide
    expect((await reuseUnderCap(cjk.length + 100, 100, cjk)).frontier).not.toContain(OFF_MAP);
    expect((await reuseUnderCap(bytes, 100, cjk)).frontier).toContain(OFF_MAP);
  }, 60_000);

  test("a recorded size larger than the stored html counts too (the larger of the two decides)", async () => {
    // the html fits the cap, but the page was recorded as larger (its encoded Content-Length): it is not parsed
    expect((await reuseUnderCap(HOME_BYTES, HOME_BYTES + 1_000)).frontier).not.toContain(OFF_MAP);
    // and with a recorded size that fits as well it is
    expect((await reuseUnderCap(HOME_BYTES, HOME_BYTES)).frontier).toContain(OFF_MAP);
  }, 60_000);

  test("no cap: the cached page is parsed and its links discovered, as before", async () => {
    expect((await reuseUnderCap(undefined)).frontier).toContain(OFF_MAP);
  }, 30_000);
});
