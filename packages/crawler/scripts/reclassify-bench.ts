// Cost of toggling the page classifier over a warm crawl cache (squirrelscan/repo#3369).
// Serves PAGES synthetic pages from a local Bun.serve (no third-party hosts), crawls once with the
// classifier off, then re-audits incrementally with it on, then off again, reporting server-side
// request counts and wall time per pass. Run: bun run scripts/reclassify-bench.ts [pages]
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";
import type { PageClassifierHook } from "@squirrelscan/parser";

import { Effect } from "effect";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const PAGES = Number(process.argv[2] ?? 600);
let requests = 0;
const body = (i: number) => {
  const links = Array.from({ length: 12 }, (_, k) => `/p${(i * 7 + k * 13 + 1) % PAGES}`)
    .map((h) => `<a href="${h}">link ${h}</a>`)
    .join("");
  const filler = "<p>lorem ipsum dolor sit amet consectetur</p>".repeat(150);
  return `<!doctype html><html><head><title>Page ${i}</title></head><body><nav><a href="/">home</a></nav><main><h1>Page ${i}</h1>${links}${filler}</main></body></html>`;
};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    requests++;
    const m = /^\/p(\d+)$/.exec(new URL(req.url).pathname);
    const i = m ? Number(m[1]) : 0;
    return new Response(body(i), {
      headers: { "content-type": "text/html", "cache-control": "max-age=3600" },
    });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

const fetcher: DocumentFetcher = {
  id: "local",
  capabilities: { jsRendering: false, cookies: false, screenshot: false },
  async fetch(req) {
    const res = await fetch(req.url, { redirect: "manual" });
    const text = await res.text();
    return {
      url: req.url,
      finalUrl: req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: text,
      timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
      redirectChain: {
        sourceUrl: req.url,
        finalUrl: req.url,
        hops: [{ url: req.url, statusCode: res.status, type: "http" as const }],
        chainLength: 0,
        isLoop: false,
        endsInError: false,
        httpsToHttp: false,
        httpToHttps: false,
      },
    } satisfies FetchResponse;
  },
};

const hook = (version: string): PageClassifierHook =>
  Object.assign(
    () => ({
      classification: {
        pageType: { label: "other", confidence: 0.9, source: "model" as const },
        degraded: "",
      },
      placeLink: () => null,
    }),
    { version },
  );

const emptyStats = {
  pagesTotal: 0, pagesFetched: 0, pagesFailed: 0, pagesSkipped: 0, pagesUnchanged: 0,
  linksTotal: 0, imagesTotal: 0, bytesTotal: 0, avgLoadTimeMs: 0,
};

const storage = await Effect.runPromise(createTestStorage());
async function pass(label: string, incremental: boolean, classify?: PageClassifierHook) {
  const config = {
    delayMs: 0, timeoutMs: 5000, userAgent: "bench", followRedirects: true, respectRobots: false,
    include: [], exclude: [], allowQueryParams: [], dropQueryPrefixes: [], breadthFirst: false,
    coverageMode: "full" as const, allowedDomains: ["127.0.0.1"], maxPages: PAGES + 10,
    incremental, useCacheControl: true, maxStalenessSeconds: 999_999,
  };
  const crawlId = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN, seedUrl: `${ORIGIN}/p0`, originalUrl: `${ORIGIN}/p0`, startedAt: Date.now(),
      status: "paused", config, stats: emptyStats,
    }),
  );
  await Effect.runPromise(
    storage.upsertFrontier(crawlId, {
      normalizedUrl: `${ORIGIN}/p0`, rawUrl: `${ORIGIN}/p0`, depth: 0, priority: 1,
      status: "pending" as const, source: "seed", enqueuedAt: Date.now(), retryCount: 0,
    }),
  );
  const crawler = await Effect.runPromise(
    createCrawler({ config: { ...config, documentFetcher: fetcher }, storage, ...(classify ? { classify } : {}) }),
  );
  requests = 0;
  const t0 = performance.now();
  await Effect.runPromise(crawler.resumeFromStorage(crawlId));
  const ms = Math.round(performance.now() - t0);
  const pages = (await Effect.runPromise(storage.getPages(crawlId))).length;
  console.log(`${label}: pages=${pages} fetches=${requests} wall=${ms}ms`);
}

await pass("1 cold crawl, classifier off", false);
await pass("2 re-audit, classifier ON (off -> on)", true, hook("bench-1"));
await pass("3 re-audit, classifier OFF (on -> off)", true);
await pass("4 re-audit, classifier ON again", true, hook("bench-1"));
await Effect.runPromise(storage.close());
server.stop(true);
