// #318 — per-website maxDepth must cap crawl depth. Seed = depth 0; a child
// link is depth+1. maxDepth=N stops enqueuing anything past depth N. Unset =
// unlimited (regression guard for the default crawl path).
//
// Offline: resumeFromStorage with a pre-seeded seed + a fetcher that serves a
// linked chain (/ → /a → /b → /c), so discovery enqueues each next depth.

import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createCrawler } from "../../src/crawler/core";
import { createTestStorage } from "../../src/crawler/storage";

const HOST = "http://depth.invalid";

// Linear chain: each page links to the next-deeper page; /c is a leaf.
const NEXT: Record<string, string | null> = {
  "/": "/a",
  "/a": "/b",
  "/b": "/c",
  "/c": null,
};

function pageBody(path: string): string {
  const next = NEXT[path];
  const link = next ? `<a href="${HOST}${next}">next</a>` : "";
  return `<!doctype html><html><head><title>t</title></head><body>${link}</body></html>`;
}

const chainFetcher: DocumentFetcher = {
  id: "mock",
  capabilities: { jsRendering: false, cookies: false, screenshot: false },
  async fetch(req) {
    const path = new URL(req.url).pathname;
    return {
      url: req.url,
      finalUrl: req.url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: pageBody(path),
      timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
      redirectChain: {
        sourceUrl: req.url,
        finalUrl: req.url,
        hops: [{ url: req.url, statusCode: 200, type: "http" as const }],
        chainLength: 0,
        isLoop: false,
        endsInError: false,
        httpsToHttp: false,
        httpToHttps: false,
      },
    };
  },
};

const BASE_CONFIG = {
  maxPages: 50,
  concurrency: 2,
  perHostConcurrency: 2,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: 5000,
  userAgent: "test",
  followRedirects: true,
  respectRobots: false,
  incremental: false,
  include: [],
  exclude: [],
  allowQueryParams: [],
  dropQueryPrefixes: [],
  allowedDomains: ["depth.invalid"],
  breadthFirst: true,
  coverageMode: "full" as const,
  disableLinkDiscovery: false,
};

async function crawledPaths(maxDepth: number | undefined): Promise<string[]> {
  const storage = await Effect.runPromise(createTestStorage());
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: HOST,
      seedUrl: `${HOST}/`,
      originalUrl: `${HOST}/`,
      startedAt: Date.now(),
      status: "paused",
      config: BASE_CONFIG,
      stats: {
        pagesTotal: 0,
        pagesFetched: 0,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    })
  );

  await Effect.runPromise(
    storage.upsertFrontier(crawlId, {
      normalizedUrl: `${HOST}/`,
      rawUrl: `${HOST}/`,
      depth: 0,
      priority: 1,
      status: "pending",
      source: "seed",
      enqueuedAt: Date.now(),
      retryCount: 0,
    })
  );

  const crawler = await Effect.runPromise(
    createCrawler({
      config: { ...BASE_CONFIG, maxDepth, documentFetcher: chainFetcher },
      storage,
    })
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));

  const pages = await Effect.runPromise(storage.getPages(crawlId));
  await Effect.runPromise(storage.close());
  return pages.map((p) => new URL(p.url).pathname).sort();
}

describe("crawler maxDepth", () => {
  test("maxDepth=1 crawls only the seed and its direct links", async () => {
    expect(await crawledPaths(1)).toEqual(["/", "/a"]);
  }, 30000);

  test("maxDepth=2 reaches depth 2 but not 3", async () => {
    expect(await crawledPaths(2)).toEqual(["/", "/a", "/b"]);
  }, 30000);

  test("unset maxDepth crawls the full chain (default = unlimited)", async () => {
    expect(await crawledPaths(undefined)).toEqual(["/", "/a", "/b", "/c"]);
  }, 30000);
});
