// pub#841 review: a page reused from the cache keeps the classification stored in its parsed data, so
// a changed classifier never relabelled an unchanged page. A cached page whose stored classification is
// from another classifier is re-parsed from its stored html, with no fetch (repo#3369). Drives a real two-pass incremental crawl.

import type { CrawlerConfigSnapshot } from "@squirrelscan/core-contracts";
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import type { PageClassifierHook } from "@squirrelscan/parser";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { CrawlStorage, PageRecord } from "../src/storage/types";

import { cachedClassificationIsStale, createCrawler, reclassifyCachedPage } from "../src/core/crawler";
import { createTestStorage } from "../src/storage";

const ORIGIN = "http://h.invalid";

function html(...links: string[]): string {
  const anchors = links.map((p) => `<a href="${ORIGIN}${p}">${p}</a>`).join("");
  return `<!doctype html><html><head><title>t</title></head><body>${anchors}</body></html>`;
}

const SITE: Record<string, string> = {
  [`${ORIGIN}/`]: html("/listed", "/off-map"),
  [`${ORIGIN}/listed`]: html(),
  [`${ORIGIN}/off-map`]: html(),
};

function mockResponse(url: string, body: string): FetchResponse {
  return {
    url,
    finalUrl: url,
    status: 200,
    // max-age keeps every stored page fresh on pass 2, so it is reused unfetched.
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

function fetcherFor(fetched: string[]): DocumentFetcher {
  return {
    id: "mock",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req) {
      fetched.push(req.url);
      return mockResponse(req.url, SITE[req.url] ?? html());
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
      config: config as unknown as CrawlerConfigSnapshot, // tests record a partial snapshot
      stats: emptyStats,
    }),
  );
}

async function seedFrontier(
  storage: CrawlStorage,
  crawlId: string,
  entries: Array<{ path: string; source: "seed" | "sitemap" }>,
) {
  for (const { path, source } of entries) {
    await Effect.runPromise(
      storage.upsertFrontier(crawlId, {
        normalizedUrl: `${ORIGIN}${path}`,
        rawUrl: `${ORIGIN}${path}`,
        depth: source === "seed" ? 0 : 1,
        priority: 1,
        status: "pending" as const,
        source,
        enqueuedAt: Date.now(),
        retryCount: 0,
      }),
    );
  }
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

// Pass 1 classifies with `first` (undefined = classifier off) and caches the page; pass 2 is an
// incremental re-run with `second`. Returns what pass 2 fetched and its stored label's stamp.
async function run(first: string | undefined, second: string | undefined, pass2: { maxParseBytes?: number } = {}) {
  const storage = await Effect.runPromise(createTestStorage());
  const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
  const crawlId1 = await createCrawlRecord(storage, cfg1);
  await seedFrontier(storage, crawlId1, [{ path: "/", source: "seed" }]);
  const crawler1 = await Effect.runPromise(
    createCrawler({
      config: { ...cfg1, documentFetcher: fetcherFor([]) },
      storage,
      ...(first ? { classify: hookFor(first) } : {}),
    }),
  );
  await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));

  const fetched: string[] = [];
  const cfg2 = { ...baseConfig, incremental: true, useCacheControl: true, maxStalenessSeconds: 999_999, ...pass2 };
  const crawlId2 = await createCrawlRecord(storage, cfg2);
  await seedFrontier(storage, crawlId2, [{ path: "/", source: "seed" }]);
  const crawler2 = await Effect.runPromise(
    createCrawler({
      config: { ...cfg2, documentFetcher: fetcherFor(fetched) },
      storage,
      ...(second ? { classify: hookFor(second) } : {}),
    }),
  );
  await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
  const pages = await Effect.runPromise(storage.getPages(crawlId2));
  const stored = pages.find((p) => p.normalizedUrl === `${ORIGIN}/`)?.parsedData ?? "";
  await Effect.runPromise(storage.close());
  const model = /"classifierVersion":"([^"]*)"/.exec(stored)?.[1];
  return { fetched, model, hasClassification: stored.includes('"classification"') };
}

describe("a cached page is reclassified when the classifier changed", () => {
  test("a classifier that answered nothing still stamps the page, so the second run reuses it", async () => {
    const nullHook = Object.assign(() => null, { version: "m1" }) as unknown as PageClassifierHook;
    const storage = await Effect.runPromise(createTestStorage());
    const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
    const crawlId1 = await createCrawlRecord(storage, cfg1);
    await seedFrontier(storage, crawlId1, [{ path: "/", source: "seed" }]);
    const crawler1 = await Effect.runPromise(
      createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([]) }, storage, classify: nullHook }),
    );
    await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
    const fetched: string[] = [];
    const cfg2 = { ...baseConfig, incremental: true, useCacheControl: true, maxStalenessSeconds: 999_999 };
    const crawlId2 = await createCrawlRecord(storage, cfg2);
    await seedFrontier(storage, crawlId2, [{ path: "/", source: "seed" }]);
    const crawler2 = await Effect.runPromise(
      createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched) }, storage, classify: nullHook }),
    );
    await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
    await Effect.runPromise(storage.close());
    expect(fetched).toEqual([]);
  }, 30000);

  test("same classifier: the page is reused from cache, label kept", async () => {
    const r = await run("m1", "m1");
    expect(r.fetched).toEqual([]);
    expect(r.model).toBe("m1");
  }, 30000);

  test("a new model or rules version: the page is re-classified from stored html (no fetch) and carries the new stamp", async () => {
    const r = await run("m1", "m2");
    expect(r.fetched).toEqual([]);
    expect(r.model).toBe("m2");
  }, 30000);

  test("a stored page over the parse cap is not re-parsed from stored html: it goes back to the fetch path (#1502)", async () => {
    const r = await run("m1", "m2", { maxParseBytes: 10 });
    expect(r.fetched).toEqual([`${ORIGIN}/`]);
    expect(r.model).toBeUndefined();
  }, 30000);

  test("a stored page under the parse cap is still re-classified without a fetch", async () => {
    const r = await run("m1", "m2", { maxParseBytes: 1_000_000 });
    expect(r.fetched).toEqual([]);
    expect(r.model).toBe("m2");
  }, 30000);

  test("classifier switched off: the cached label is stripped without a fetch", async () => {
    const r = await run("m1", undefined);
    expect(r.fetched).toEqual([]);
    expect(r.hasClassification).toBe(false);
  }, 30000);

  test("a page labelled before stamps existed is stripped without a fetch when the classifier is off", async () => {
    // A hook with no version stores a label and no stamp, as v0.0.144 did.
    const unversioned = Object.assign(hookFor("m1"), { version: undefined }) as PageClassifierHook;
    const storage = await Effect.runPromise(createTestStorage());
    const cfg1 = { ...baseConfig, incremental: false, useCacheControl: false };
    const crawlId1 = await createCrawlRecord(storage, cfg1);
    await seedFrontier(storage, crawlId1, [{ path: "/", source: "seed" }]);
    const crawler1 = await Effect.runPromise(
      createCrawler({ config: { ...cfg1, documentFetcher: fetcherFor([]) }, storage, classify: unversioned }),
    );
    await Effect.runPromise(crawler1.resumeFromStorage(crawlId1));
    const fetched: string[] = [];
    const cfg2 = { ...baseConfig, incremental: true, useCacheControl: true, maxStalenessSeconds: 999_999 };
    const crawlId2 = await createCrawlRecord(storage, cfg2);
    await seedFrontier(storage, crawlId2, [{ path: "/", source: "seed" }]);
    const crawler2 = await Effect.runPromise(
      createCrawler({ config: { ...cfg2, documentFetcher: fetcherFor(fetched) }, storage }),
    );
    await Effect.runPromise(crawler2.resumeFromStorage(crawlId2));
    const stored = (await Effect.runPromise(storage.getPages(crawlId2))).find((p) => p.normalizedUrl === `${ORIGIN}/`)?.parsedData ?? "";
    await Effect.runPromise(storage.close());
    expect(fetched).toEqual([]);
    expect(stored.includes('"classification"')).toBe(false);
  }, 30000);

  test("classifier switched on over a page cached without a label: labelled from stored html, no fetch", async () => {
    const r = await run(undefined, "m1");
    expect(r.fetched).toEqual([]);
    expect(r.model).toBe("m1");
  }, 30000);
});

describe("cachedClassificationIsStale", () => {
  const stamped = (version: string) =>
    JSON.stringify({ classifierVersion: version, meta: {}, classification: { pageType: { label: "x" }, degraded: "" } });
  const unstampedWithLabel = JSON.stringify({ meta: {}, classification: { pageType: { label: "x" }, degraded: "" } });
  test("compares the stored stamp with the running classifier's", () => {
    expect(cachedClassificationIsStale(stamped("a"), "a")).toBe(false);
    expect(cachedClassificationIsStale(stamped("a"), "b")).toBe(true);
    expect(cachedClassificationIsStale(stamped("a"), undefined)).toBe(true);
    expect(cachedClassificationIsStale(JSON.stringify({ meta: {} }), "a")).toBe(true);
    expect(cachedClassificationIsStale(JSON.stringify({ meta: {} }), undefined)).toBe(false);
  });
  test("a page the classifier answered nothing for is stamped, so it caches (no refetch every run)", () => {
    expect(cachedClassificationIsStale(JSON.stringify({ classifierVersion: "a", meta: {} }), "a")).toBe(false);
  });
  test("a nested classifierVersion in the page's own data is not the stamp, before or after the real one", () => {
    const nested = { schema: { all: [{ "@type": "Thing", classifierVersion: "evil", classification: { model: "evil" } }] } };
    const real = JSON.stringify({ classifierVersion: "a", meta: {}, ...nested });
    expect(cachedClassificationIsStale(real, "a")).toBe(false);
    expect(cachedClassificationIsStale(real, "evil")).toBe(true);
    // Unstamped page whose JSON-LD carries the exact key: it must read as unstamped, not as "evil".
    const unstamped = JSON.stringify({ meta: {}, ...nested });
    expect(cachedClassificationIsStale(unstamped, "evil")).toBe(true);
    expect(cachedClassificationIsStale(unstamped, "a")).toBe(true);
  });
  test("classifier OFF: an unstamped page that carries a label is stale, so --no-classifier is honoured", () => {
    expect(cachedClassificationIsStale(unstampedWithLabel, undefined)).toBe(true);
  });
  test("classifier OFF: an unstamped page with no label, or only a nested one, is not stale", () => {
    expect(cachedClassificationIsStale(JSON.stringify({ meta: {} }), undefined)).toBe(false);
    const nestedOnly = JSON.stringify({ meta: {}, schema: { all: [{ classification: "spam" }] } });
    expect(cachedClassificationIsStale(nestedOnly, undefined)).toBe(false);
  });
  test("a page with no parsed data has nothing to relabel", () => {
    expect(cachedClassificationIsStale(null, "a")).toBe(false);
    expect(cachedClassificationIsStale("", "a")).toBe(false);
  });
  test("a label stored without a stamp (before it existed) is stale for any classifier", () => {
    expect(cachedClassificationIsStale(unstampedWithLabel, "a")).toBe(true);
  });
});

describe("reclassifyCachedPage", () => {
  const page = {
    finalUrl: `${ORIGIN}/`,
    html: html("/a"),
    parsedData: JSON.stringify({ classifierVersion: "m1", classification: {}, meta: {} }),
  } as unknown as PageRecord;
  test("re-parses the stored html under the running classifier", () => {
    const out = reclassifyCachedPage(page, hookFor("m2"));
    expect(out?.parsedData).toContain('"classifierVersion":"m2"');
  });
  test("classifier off strips the label and the stamp", () => {
    const out = reclassifyCachedPage(page, undefined);
    expect(out?.parsedData).not.toContain("classifierVersion");
    expect(out?.parsedData).not.toContain('"classification"');
  });
  test("no stored html: null, so the caller fetches", () => {
    expect(reclassifyCachedPage({ ...page, html: null }, hookFor("m2"))).toBeNull();
  });
});
