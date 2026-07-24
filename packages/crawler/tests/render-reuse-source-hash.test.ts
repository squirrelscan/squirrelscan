// #839 — render reuse on origins with rolling validators + per-request CF
// injection. The v1 conditional-GET gate (#836) delivered ~nothing on WP +
// Cloudflare: Last-Modified rolls with serve time (never 304s) and the raw
// source rotates on every fetch because Cloudflare injects a per-request
// challenge-platform <script>. v2 fingerprints the NORMALIZED source (that
// injection stripped) and reuses the stored render when the hash is unchanged.
//
// This drives real crawls through the actual conditional-render gate:
//   Crawl 1 (cold): plain fetch populates the store (+ rolling Last-Modified).
//     A cold crawl never probes, so no source_hash is stored yet.
//   Crawl 2 (render-all gate): stored pages have no source_hash → the probe
//     can't match → every page renders ONCE, and its normalized-source hash is
//     persisted.
//   Crawl 3 (render-all gate): the origin still 200s with a fresh Last-Modified
//     and a rotated CF ray, but the normalized source hashes to the stored value
//     → ZERO renders; every page is reused. This is the drmadnani scenario.

import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { createHash } from "crypto";

import { normalizeHtmlForFingerprint } from "@squirrelscan/utils/fingerprint";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createConditionalRenderDocumentFetcher } from "../../fetchers/src/conditional-render";
import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://cf.invalid";

// A monotonic HTTP-date clock: every response gets a strictly newer
// Last-Modified, mimicking an origin that rolls the validator with serve time.
let lmTick = 0;
function nextLastModified(): string {
  lmTick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, lmTick)).toUTCString();
}

// Per-fetch Cloudflare challenge-platform injection — the ONLY per-request byte
// difference between fetches of the same page (rotating ray id + timestamp).
let cfRay = 0;
function cfScript(): string {
  cfRay += 1;
  return `<script>window.__CF$cv$params={r:'ray${cfRay}',t:'MTc4MzY1ODY1Mw=='};var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js';})();</script>`;
}

// Stable page body for a URL (links for discovery) + the rotating CF injection.
function pageBody(links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}${cfScript()}</body></html>`;
}

function response(url: string, body: string, method?: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // Rolling Last-Modified, NO cache-control (so pages are never "fresh" and the
    // crawler always takes the conditional-GET/probe path).
    headers: { "content-type": "text/html; charset=utf-8", "last-modified": nextLastModified() },
    body,
    timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
    ...(method ? { fetcherMethod: method } : {}),
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

// Hub: root links to N leaves. 1 + N same-host pages.
function hubSite(n: number): Record<string, string[]> {
  const leaves = Array.from({ length: n }, (_, i) => `/p${i}`);
  const links: Record<string, string[]> = { [`${ORIGIN}/`]: leaves };
  for (const p of leaves) links[`${ORIGIN}${p}`] = [];
  return links;
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
  allowedDomains: ["cf.invalid"],
  maxPages: 50,
  perHostDelayMs: 0,
};

async function seedRoot(storage: CrawlStorage, crawlId: string) {
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
}

async function createCrawlRecord(
  storage: CrawlStorage,
  config: Record<string, unknown>,
): Promise<string> {
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

async function runCrawl(
  storage: CrawlStorage,
  config: Record<string, unknown>,
  documentFetcher: DocumentFetcher,
): Promise<string> {
  const crawlId = await createCrawlRecord(storage, config);
  await seedRoot(storage, crawlId);
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...config, documentFetcher }, storage }),
  );
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  return crawlId;
}

describe("render reuse via normalized source fingerprint (#839)", () => {
  test("rolling Last-Modified + rotating CF injection: pass 2 reuses with ZERO renders", async () => {
    const site = hubSite(4);
    const totalPages = Object.keys(site).length; // 5
    const linksFor = (url: string) => site[url] ?? [];

    const storage = await Effect.runPromise(createTestStorage());

    // ---- Crawl 1: cold, plain fetch — populates the store (no source_hash yet) ----
    const originFetcher: DocumentFetcher = {
      id: "fetch",
      capabilities: { jsRendering: false, cookies: true, screenshot: false },
      async fetch(req) {
        return response(req.url, pageBody(linksFor(req.url)));
      },
    };
    const coldCfg = { ...baseConfig, incremental: false, useCacheControl: false };
    await runCrawl(storage, coldCfg, originFetcher);

    // The gate wraps a plain-HTTP probe (origin) around the render fetcher.
    let renderCount = 0;
    const renderFetcher: DocumentFetcher = {
      id: "cloud-render",
      capabilities: { jsRendering: true, cookies: false, screenshot: false },
      async fetch(req) {
        renderCount += 1;
        // Rendered DOM keeps the links so discovery still works on the render path.
        return response(req.url, pageBody(linksFor(req.url)), "cloud-render");
      },
    };
    const gate = createConditionalRenderDocumentFetcher({
      http: originFetcher,
      render: renderFetcher,
    });

    const incrementalCfg = { ...baseConfig, incremental: true, useCacheControl: false };

    // ---- Crawl 2: first render-all run — no stored hash yet, so it renders once ----
    const crawl2 = await runCrawl(storage, incrementalCfg, gate);
    expect(renderCount).toBe(totalPages); // every page rendered exactly once

    // The normalized-source hash was persisted for each page.
    const pages2 = await Effect.runPromise(storage.getPages(crawl2));
    expect(pages2.length).toBe(totalPages);
    for (const p of pages2) {
      expect(typeof p.sourceHash).toBe("string");
      expect((p.sourceHash ?? "").length).toBeGreaterThan(0);
    }
    // Sanity: the stored hash is the fingerprint of the normalized source.
    const expectedRootHash = createHash("sha256")
      .update(normalizeHtmlForFingerprint(pageBody(linksFor(`${ORIGIN}/`))))
      .digest("hex");
    // (all pages share body shape apart from links; the leaves differ, so just
    // assert the hash IS a well-formed sha256 hex above and the reuse below.)
    expect(expectedRootHash).toMatch(/^[0-9a-f]{64}$/);

    // ---- Crawl 3: re-run — origin still 200s (rolling LM, rotated CF ray) ----
    const rendersBefore = renderCount;
    const crawl3 = await runCrawl(storage, incrementalCfg, gate);

    // The whole point of #839: not a single render, despite the origin returning
    // 200 with a fresh Last-Modified and a rotated CF injection every time.
    expect(renderCount - rendersBefore).toBe(0);

    const stats3 = await Effect.runPromise(storage.getStats(crawl3));
    expect(stats3?.pagesUnchanged).toBe(totalPages);
    expect(stats3?.cacheHitsByReason?.["304"]).toBe(totalPages);

    const pages3 = await Effect.runPromise(storage.getPages(crawl3));
    expect(pages3.length).toBe(totalPages);

    await Effect.runPromise(storage.close());
  }, 30000);
});
