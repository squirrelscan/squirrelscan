// pub#807: `squirrel audit --offline` promises no request to a host outside the
// audited site. The asset phase still status-checked the third-party scripts,
// stylesheets and fonts the pages load (reliability/broken-resources, #703):
// that probe was gated only on the rule. An own-site-only run now skips it, so
// the rule reads third-party resources as not measured, never as passing.
//
// The same goes for sitemap URLs on another site (crawl/sitemap-4xx): they are
// left unchecked, and the rule says how many on a row of its own.
//
// The third-party references are on `.invalid`, which a public site's audit
// refuses on the URL alone, so the control can see the probe run without any
// request leaving the machine.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import {
  buildSiteContext,
  fetchResourceAssets,
  runRulesOnStorage,
  runStreamingRules,
} from "../src/adapter";

const BASE = "https://site.example.com";
const SITEMAP = `${BASE}/sitemap.xml`;
const OFF_SITE = "https://elsewhere.invalid/page";

const CONFIG = {
  rule_options: {},
  rules: { enable: ["reliability/broken-resources", "crawl/sitemap-4xx"] },
  crawler: { max_pages: 10, exclude: [] },
  external_links: { enabled: false },
  internal_links: { enabled: false },
} as unknown as Config;

const HOME = `<!doctype html><html lang="en"><head><title>Home</title>
  <link rel="stylesheet" href="https://cdn.invalid/site.css">
  <script src="https://widgets.invalid/w.js"></script>
</head><body><p>Home</p></body></html>`;

function homePage(html: string): PageRecord {
  const url = `${BASE}/`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: html.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: "hash-home",
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

type Engine = "v1" | "streaming";

/**
 * The asset phase, then the rules through one of the two real runners, so the
 * site data each runner builds is what the rules read.
 */
function audit(ownSiteOnly: boolean, engine: Engine = "v1", html = HOME) {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
        originalUrl: `${BASE}/`,
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: {} as never,
      } as never);
      yield* storage.upsertPage(crawlId, homePage(html));
      // The sitemap lists the crawled home page and one page on another site.
      yield* storage.addSitemap(crawlId, {
        url: SITEMAP,
        type: "urlset",
        urlCount: 2,
        childSitemaps: [],
        errors: [],
        fetchedAt: 1_700_000_000_000,
      });
      yield* storage.addSitemapUrls(crawlId, [
        { sitemapUrl: SITEMAP, loc: `${BASE}/` },
        { sitemapUrl: SITEMAP, loc: OFF_SITE },
      ]);
      const siteContext = yield* buildSiteContext(yield* storage.getPages(crawlId));
      const assets = yield* fetchResourceAssets(
        storage,
        crawlId,
        siteContext,
        CONFIG,
        ownSiteOnly ? { ownSiteOnly: true } : undefined,
      );
      const ran = (yield* engine === "v1"
        ? runRulesOnStorage(storage, crawlId, siteContext, CONFIG, assets)
        : runStreamingRules(storage, crawlId, CONFIG, assets)) as {
        siteRuleResults: Map<string, CheckResult[]>;
      };
      const checksOf = (id: string) => ran.siteRuleResults.get(id) ?? [];
      return {
        assets,
        brokenResources: checksOf("reliability/broken-resources"),
        sitemap4xx: checksOf("crawl/sitemap-4xx"),
      };
    }).pipe(Effect.orDie, Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

describe("an own-site-only (--offline) audit and third-party assets (pub#807)", () => {
  test("control: a normal audit status-checks the third-party references and the off-site sitemap URL", async () => {
    const { assets } = await audit(false);
    const urls = [
      ...(assets.externalAssets?.css ?? []),
      ...(assets.externalAssets?.scripts ?? []),
    ].map((a) => a.url);
    expect(urls.sort()).toEqual(["https://cdn.invalid/site.css", "https://widgets.invalid/w.js"]);
    expect(assets.sitemapUrlStatuses.map((s) => s.url)).toEqual([OFF_SITE]);
    expect(assets.sitemapOffSiteSkipped).toBeUndefined();
  });

  test("an own-site-only audit checks none, and the rule says they were not measured", async () => {
    const { assets, brokenResources } = await audit(true);
    expect(assets.externalAssets).toBeUndefined();

    const unchecked = brokenResources.find((c) => c.name === "unchecked-resources");
    expect(unchecked?.message).toContain("third-party resources were not measured this audit");
    // Not measured is not a pass: no broken-resources row at all.
    expect(brokenResources.some((c) => c.name === "broken-resources")).toBe(false);
  });

  test("pages with no third-party reference leave nothing unmeasured", async () => {
    const { assets, brokenResources } = await audit(
      true,
      "v1",
      `<!doctype html><html lang="en"><head><title>Home</title></head><body><p>Home</p></body></html>`,
    );
    expect(assets.externalAssets).toEqual({ scripts: [], css: [], fonts: [] });
    expect(
      brokenResources.some((c) => c.message.includes("third-party resources were not measured")),
    ).toBe(false);
  });

  for (const engine of ["v1", "streaming"] as const) {
    test(`${engine}: the off-site sitemap URL is left unchecked, and sitemap-4xx says so`, async () => {
      const { assets, sitemap4xx } = await audit(true, engine);
      expect(assets.sitemapUrlStatuses).toEqual([]);
      expect(assets.sitemapOffSiteSkipped).toBe(1);

      expect(sitemap4xx.find((c) => c.name === "sitemap-4xx")?.status).toBe("skipped");
      const offSite = sitemap4xx.find((c) => c.name === "sitemap-off-site-not-checked");
      expect(offSite?.status).toBe("info");
      expect(offSite?.message).toBe("1 sitemap URL(s) on another site not checked this audit");
    });
  }
});
