// #1777: a targeted run must treat a CACHED redirect like a fresh one. A full audit caches `/old` (301 to
// `/new`); a later `targetUrls: [/old]` run reuses the cached row and must neither queue nor audit `/new`.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";

function html(...links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

const SITE: Record<string, string> = {
  [`${ORIGIN}/new`]: html(),
};

function response(url: string, redirectTo?: string): FetchResponse {
  const finalUrl = redirectTo ?? url;
  return {
    url,
    finalUrl,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" },
    body: SITE[finalUrl] ?? html(),
    timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
    redirectChain: {
      sourceUrl: url,
      finalUrl,
      hops: redirectTo
        ? [{ url, statusCode: 301, type: "http" as const }]
        : [{ url, statusCode: 200, type: "http" as const }],
      chainLength: redirectTo ? 1 : 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  };
}

function fetcherFor(fetched: string[]): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      return response(req.url, req.url === `${ORIGIN}/old` ? `${ORIGIN}/new` : undefined);
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

async function createCrawlRecord(storage: CrawlStorage, config: Record<string, unknown>): Promise<string> {
  return Effect.runPromise(
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
}

async function seed(storage: CrawlStorage, crawlId: string, path: string) {
  await Effect.runPromise(
    storage.upsertFrontier(crawlId, {
      normalizedUrl: `${ORIGIN}${path}`,
      rawUrl: `${ORIGIN}${path}`,
      depth: 0,
      priority: 1,
      status: "pending" as const,
      source: "carried",
      enqueuedAt: Date.now(),
      retryCount: 0,
    }),
  );
}

describe("a cached redirect in a targeted run (#1777)", () => {
  test("/old is reused from cache; /new is neither queued nor audited, and is named as the destination", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    // Pass 1: a full audit that caches /old (a 301 to /new) and, through the redirect, /new.
    const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
    const crawlId1 = await createCrawlRecord(storage, cfg1);
    await seed(storage, crawlId1, "/old");
    const crawler1 = await Effect.runPromise(
      createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([]) }, storage }),
    );
    await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
    const full = await Effect.runPromise(storage.getAllFrontierEntries(crawlId1));
    // Sanity: the full audit did queue the destination.
    expect(full.map((e) => e.normalizedUrl)).toContain(`${ORIGIN}/new`);

    // Pass 2: targeted at /old only, from cache.
    const fetched: string[] = [];
    const cfg2 = {
      ...baseConfig,
      incremental: true,
      useCacheControl: true,
      maxStalenessSeconds: 999_999,
      targetUrls: [`${ORIGIN}/old`],
    };
    const crawlId2 = await createCrawlRecord(storage, cfg2);
    await seed(storage, crawlId2, "/old");
    const crawler2 = await Effect.runPromise(
      createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched) }, storage }),
    );
    await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
    const entries = await Effect.runPromise(storage.getAllFrontierEntries(crawlId2));
    const stats = await Effect.runPromise(storage.getStats(crawlId2));
    await Effect.runPromise(storage.close());

    // Reused, not fetched (the premise of the test).
    expect(fetched).toEqual([]);
    expect(stats?.pagesUnchanged ?? 0).toBeGreaterThan(0);
    // The destination is not queued: its only row is the skipped marker naming /old as its source.
    const dest = entries.filter((e) => e.normalizedUrl === `${ORIGIN}/new`);
    expect(dest.map((e) => [e.status, e.reason, e.parentUrl])).toEqual([
      ["skipped", "redirect_not_targeted", `${ORIGIN}/old`],
    ]);
    expect(entries.filter((e) => e.status === "pending")).toEqual([]);
  }, 30000);
});
