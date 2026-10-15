// pub#788 end-to-end: integrity/orphan-page never treats the page the crawl
// started on as hidden, through the REAL adapter on both engine paths.
//
// A root that redirects to a sign-in page (or `/en/`) lands the crawl there, and
// nothing links to it. `SiteData.entryUrls` is filled by the adapter from the
// crawl's `seedUrl` / `originalUrl`, so only a run through `runRulesOnStorage`
// and `runStreamingRules` proves both builders hand it to the rule.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const BASE = "https://site.example.com";
const LANDING = `${BASE}/v3/signin/identifier?continue=x`;

const CONFIG = {
  rule_options: {},
  rules: { enable: ["integrity/orphan-page"] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

function pageRecord(url: string, links: string[]): PageRecord {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  const html = `<!doctype html><html lang="en"><head><title>${url}</title></head><body><p>Body copy.</p>${anchors}</body></html>`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${url}`,
    html,
    parsedData: null,
    headers: { contentType: "text/html" },
    securityHeaders: {},
    redirectChain: {
      sourceUrl: url,
      finalUrl: url,
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
  } as unknown as PageRecord;
}

// The landing page is linked from nowhere; /help and /privacy link each other.
const PAGES = [
  pageRecord(LANDING, []),
  pageRecord(`${BASE}/help`, ["/privacy"]),
  pageRecord(`${BASE}/privacy`, ["/help"]),
];

async function orphanChecks(seedUrl: string, engine: "v1" | "streaming"): Promise<CheckResult[]> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
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
      } as never);
      for (const page of PAGES) yield* storage.upsertPage(crawlId, page);

      let result;
      if (engine === "streaming") {
        result = yield* runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, {
          batchSize: 1,
        });
      } else {
        const stored = yield* storage.getPages(crawlId);
        const siteContext = yield* buildSiteContext(stored);
        result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
      }
      return (result.ruleResultsMap.get("integrity/orphan-page")?.checks ?? []) as CheckResult[];
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

for (const engine of ["v1", "streaming"] as const) {
  describe(`pub#788 orphan-page entry page through the real adapter (${engine})`, () => {
    test("control: a landing page the crawl did not start on is hidden", async () => {
      const checks = await orphanChecks(`${BASE}/`, engine);
      const review = checks.find((c) => c.name === "orphan-page-review");
      expect(review?.items?.map((i) => i.id)).toEqual([LANDING]);
    });

    test("the page the root redirected to is the front door, not a hidden page", async () => {
      const checks = await orphanChecks(LANDING, engine);
      expect(checks.map((c) => [c.name, c.status])).toEqual([["orphan-page", "pass"]]);
    });
  });
}
