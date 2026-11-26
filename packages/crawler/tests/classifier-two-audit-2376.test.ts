// #2376: two audits of the same multi-page site. Audit 1 runs with the classifier off, audit 2 with it
// on. Audit 2 must relabel every cached page from stored html with no fetch. The same file measures
// the cost of that reclassification: CLASSIFIER_COST_PAGES=1000 bun test <this file> prints it.

import type { CrawlerConfigSnapshot } from "@squirrelscan/core-contracts";
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";
import type { PageClassifierHook } from "@squirrelscan/parser";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage } from "../src/storage/types";

import { createCrawler } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";
const COST_PAGES = Number(process.env.CLASSIFIER_COST_PAGES ?? 0);
const PAGES = COST_PAGES > 0 ? COST_PAGES : 8;

const paths = Array.from({ length: PAGES }, (_, i) => `/p${i}`);

function page(links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

function bodyFor(url: string): string {
  return url === `${ORIGIN}/` ? page(paths) : page([]);
}

function response(url: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps every stored page fresh on audit 2, so only staleness can force work.
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=3600",
    },
    body: bodyFor(url),
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

function fetcherFor(fetched: string[]): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      return response(req.url);
    },
  };
}

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
  maxPages: PAGES + 10,
};

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

async function newCrawl(
  storage: CrawlStorage,
  config: Record<string, unknown>
): Promise<string> {
  const id = await Effect.runPromise(
    storage.createCrawl({
      baseUrl: ORIGIN,
      seedUrl: `${ORIGIN}/`,
      originalUrl: `${ORIGIN}/`,
      startedAt: Date.now(),
      status: "paused",
      config: config as unknown as CrawlerConfigSnapshot, // tests record a partial snapshot
      stats: emptyStats,
    })
  );
  await Effect.runPromise(
    storage.upsertFrontier(id, {
      normalizedUrl: `${ORIGIN}/`,
      rawUrl: `${ORIGIN}/`,
      depth: 0,
      priority: 1,
      status: "pending" as const,
      source: "seed",
      enqueuedAt: Date.now(),
      retryCount: 0,
    })
  );
  return id;
}

function hookFor(version: string): PageClassifierHook {
  const hook = () => ({
    classification: {
      pageType: { label: "other", confidence: 0.95, source: "model" as const },
      degraded: "",
    },
    placeLink: () => null,
  });
  return Object.assign(hook, { version });
}

interface Audit {
  fetched: string[];
  ms: number;
  cpuMs: number;
  stored: Map<string, string>;
}

async function audit(
  storage: CrawlStorage,
  incremental: boolean,
  classify: PageClassifierHook | undefined
): Promise<Audit> {
  const fetched: string[] = [];
  const cfg = {
    ...baseConfig,
    incremental,
    useCacheControl: incremental,
    ...(incremental ? { maxStalenessSeconds: 999_999 } : {}),
  };
  const id = await newCrawl(storage, cfg);
  const crawler = await Effect.runPromise(
    createCrawler({
      config: { ...cfg, documentFetcher: fetcherFor(fetched) },
      storage,
      ...(classify ? { classify } : {}),
    })
  );
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await Effect.runPromise(crawler.resumeFromStorage(id));
  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const pages = await Effect.runPromise(storage.getPages(id));
  return {
    fetched,
    ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    stored: new Map(pages.map((p) => [p.normalizedUrl, p.parsedData ?? ""])),
  };
}

describe("two audits of one site: classifier off, then on (#2376)", () => {
  test("audit 2 relabels every cached page from stored html without refetching", async () => {
    const storage = await Effect.runPromise(createTestStorage());
    const first = await audit(storage, false, undefined);
    // Audit 1 fetched the whole site, and nothing carries a label.
    expect(first.stored.size).toBe(PAGES + 1);
    expect(first.fetched.length).toBe(PAGES + 1);
    for (const data of first.stored.values()) {
      expect(data).not.toContain('"classification"');
      expect(data).not.toContain("classifierVersion");
    }

    const second = await audit(storage, true, hookFor("m1"));
    // Reused from cache: no request went out.
    expect(second.fetched).toEqual([]);
    // Results reflect the new classification on every page.
    expect(second.stored.size).toBe(PAGES + 1);
    for (const data of second.stored.values()) {
      expect(data).toContain('"classifierVersion":"m1"');
      expect(data).toContain('"classification"');
    }

    // Baseline: a third audit under the same classifier finds nothing stale.
    const third = await audit(storage, true, hookFor("m1"));
    expect(third.fetched).toEqual([]);

    if (COST_PAGES > 0) {
      const pct = (second.ms - third.ms) / second.ms;
      console.log(
        JSON.stringify({
          pages: PAGES + 1,
          reclassifyAuditMs: Math.round(second.ms),
          reclassifyAuditCpuMs: Math.round(second.cpuMs),
          cachedAuditMs: Math.round(third.ms),
          cachedAuditCpuMs: Math.round(third.cpuMs),
          firstAuditMs: Math.round(first.ms),
          reclassifyOverheadMs: Math.round(second.ms - third.ms),
          overheadShareOfReclassifyCrawl: Number(pct.toFixed(3)),
          overheadShareOfFetchAudit: Number(
            ((second.ms - third.ms) / first.ms).toFixed(4)
          ),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
        })
      );
    }
    await Effect.runPromise(storage.close());
  }, 600_000);
});
