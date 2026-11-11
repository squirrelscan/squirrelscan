// links/click-depth (#1688) through the REAL adapter on both engine paths.
//
// A site rule gets no DOM in the streaming engine, so the rule reads link edges
// from `site.pages[].parsed.links`: this proves both builders hand it the same
// graph, and the two engines agree on the verdict.

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
  rules: { enable: ["links/click-depth"] },
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

// home -> a -> b -> c -> d; /shortcut is linked from home and from d (depth 1);
// /sitemap-only is linked from nowhere; /private is noindex at depth 4.
const PAGES = [
  pageRecord(`${BASE}/`, ["/a", "/shortcut"]),
  pageRecord(`${BASE}/a`, ["/b"]),
  pageRecord(`${BASE}/b`, ["/c"]),
  pageRecord(`${BASE}/c`, ["/d"]),
  pageRecord(`${BASE}/d`, ["/shortcut", "/private"]),
  pageRecord(`${BASE}/shortcut`, []),
  pageRecord(`${BASE}/sitemap-only`, []),
  {
    ...pageRecord(`${BASE}/private`, []),
    html: `<!doctype html><html lang="en"><head><title>p</title><meta name="robots" content="noindex"></head><body><p>x</p></body></html>`,
  } as PageRecord,
];

async function clickChecks(engine: "v1" | "streaming"): Promise<CheckResult[]> {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
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
      return (result.ruleResultsMap.get("links/click-depth")?.checks ?? []) as CheckResult[];
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

for (const engine of ["v1", "streaming"] as const) {
  describe(`links/click-depth through the real adapter (${engine})`, () => {
    test("lists only the indexable page deeper than 3, with its shortest depth", async () => {
      const checks = await clickChecks(engine);
      expect(checks).toHaveLength(1);
      const c = checks[0]!;
      expect(c.status).toBe("warn");
      expect(c.items?.map((i) => [i.id, i.meta?.depth])).toEqual([[`${BASE}/d`, 4]]);
      expect(c.details).toMatchObject({ total: 1, deepest: 4, threshold: 3 });
    });
  });
}

describe("links/click-depth engine parity", () => {
  test("v1 and streaming emit the same check", async () => {
    expect(await clickChecks("streaming")).toEqual(await clickChecks("v1"));
  });
});
