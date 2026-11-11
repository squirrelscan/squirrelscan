// #1651: the sitemap read state persisted in the crawl stats must reach crawl/sitemap-coverage's
// product-discovery check on BOTH rule paths (batch runRulesOnStorage and streaming runStreamingRules),
// and a crawl stored before the state existed must read "unknown", never "complete".

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, SitemapReadState } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const RULE = "crawl/sitemap-coverage";
const BASE = "https://shop.example.com";

const CONFIG = {
  rule_options: {},
  rules: { enable: [RULE] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = { css: new Map(), js: new Map(), images: new Map() };

const BASE_STATS = {
  pagesTotal: 3,
  pagesFetched: 3,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

function productHtml(n: number): string {
  const ld = JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: `Item ${n}` });
  return `<!doctype html><html><head><title>Item ${n}</title><script type="application/ld+json">${ld}</script></head><body><h1>Item ${n}</h1></body></html>`;
}

type Path = "batch" | "streaming";

async function productDiscovery(path: Path, readState?: SitemapReadState): Promise<CheckResult | undefined> {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        originalUrl: BASE,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: { ...BASE_STATS, ...(readState ? { sitemapReadState: readState } : {}) },
      });
      for (const n of [1, 2, 3]) {
        const html = productHtml(n);
        yield* storage.upsertPage(crawlId, {
          url: `${BASE}/products/item-${n}`,
          normalizedUrl: `${BASE}/products/item-${n}`,
          finalUrl: `${BASE}/products/item-${n}`,
          depth: 1,
          status: 200,
          contentType: "text/html",
          sizeBytes: html.length,
          loadTimeMs: 1,
          fetchedAt: Date.now(),
          etag: null,
          lastModified: null,
          contentHash: `h${n}`,
          html,
          parsedData: null,
          headers: {},
          securityHeaders: {},
        });
      }
      yield* storage.addSitemap(crawlId, {
        url: `${BASE}/sitemap.xml`,
        type: "urlset",
        urlCount: 3,
        childSitemaps: [],
        errors: [],
        fetchedAt: Date.now(),
      });
      yield* storage.addSitemapUrls(
        crawlId,
        [1, 2, 3].map((n) => ({ sitemapUrl: `${BASE}/sitemap.xml`, loc: `${BASE}/products/item-${n}` })),
      );
      const result =
        path === "batch"
          ? yield* Effect.gen(function* () {
              const pages = yield* storage.getPages(crawlId);
              const siteContext = yield* buildSiteContext(pages);
              return yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
            })
          : yield* runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 2 });
      return result.ruleResultsMap.get(RULE)?.checks.find((c) => c.name === "product-discovery");
    }).pipe(// close errors are ignored: some bun versions throw on closing an :memory: db after a run
    Effect.ensuring(storage.close().pipe(Effect.ignore))),
  );
}

describe("product-discovery sees the persisted sitemap read state (#1651)", () => {
  for (const path of ["batch", "streaming"] as const) {
    for (const state of ["complete", "partial", "unreadable"] as const) {
      test(`${path}: ${state}`, async () => {
        const check = await productDiscovery(path, state);
        expect(check).toBeDefined();
        expect(check!.details).toMatchObject({ sitemapState: state, crawledProductPages: 3 });
      });
    }
    test(`${path}: a crawl stored without the state reads unknown, not complete`, async () => {
      const check = await productDiscovery(path);
      expect(check).toBeDefined();
      expect(check!.details).toMatchObject({ sitemapState: "unknown" });
      expect(check!.message).toContain("not recorded");
    });
  }
});
