// squirrelscan/repo#1733 — a truncated sitemap walk must reach the RULES, not
// just the finished report.
//
// The first attempt at this fix set `truncated` only where the report is
// assembled, which runs AFTER the rules have scored. The flag was inert:
// crawl/sitemap-exists still saw `undefined`, took its normal path, and emitted
// the weight-10 "No XML sitemap found" for a walk that never looked. A test
// asserting on the finished report passed anyway, because the report gets its
// copy from the other path — so this drives the rule executor itself and asserts
// on the check the rule actually produced.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, runRulesOnStorage, type PreFetchedAssets } from "../src/adapter";

const EXISTS_RULE = "crawl/sitemap-exists";
const VALID_RULE = "crawl/sitemap-valid";

// `filterRules` defaults every rule to disabled, so the enable list is
// mandatory — `rules: {}` would run nothing and pass vacuously.
const CONFIG = {
  rule_options: {},
  rules: { enable: [EXISTS_RULE, VALID_RULE] },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = { css: new Map(), js: new Map(), images: new Map() };

const PAGE_HTML = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

const BASE_STATS = {
  pagesTotal: 1,
  pagesFetched: 1,
  pagesFailed: 0,
  pagesSkipped: 0,
  pagesUnchanged: 0,
  linksTotal: 0,
  imagesTotal: 0,
  bytesTotal: 0,
  avgLoadTimeMs: 0,
};

// No sitemaps stored at all — the ambiguous state. Whether that means "this site
// has none" or "we never finished looking" is exactly what the flag decides.
async function sitemapChecks(truncated: boolean): Promise<Map<string, CheckResult[]>> {
  const storage = new SQLiteStorage(":memory:");
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: "https://example.com",
        originalUrl: "https://example.com",
        startedAt: Date.now(),
        status: "completed",
        config: {} as never,
        stats: { ...BASE_STATS, sitemapDiscoveryTruncated: truncated },
      });
      yield* storage.upsertPage(crawlId, {
        url: "https://example.com/",
        normalizedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        depth: 0,
        status: 200,
        contentType: "text/html",
        sizeBytes: PAGE_HTML.length,
        loadTimeMs: 1,
        fetchedAt: Date.now(),
        etag: null,
        lastModified: null,
        contentHash: "test",
        html: PAGE_HTML,
        parsedData: null,
        headers: {},
        securityHeaders: {},
      });
      const pages = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(pages);
      const result = yield* runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS);
      return new Map([
        [EXISTS_RULE, result.ruleResultsMap.get(EXISTS_RULE)?.checks ?? []],
        [VALID_RULE, result.ruleResultsMap.get(VALID_RULE)?.checks ?? []],
      ]);
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

const named = (checks: Map<string, CheckResult[]>, ruleId: string, name: string) =>
  (checks.get(ruleId) ?? []).find((c) => c.name === name);

describe("truncated sitemap discovery reaches the rules (squirrelscan/repo#1733)", () => {
  test("a truncated walk does not produce the missing-sitemap failure", async () => {
    const check = named(await sitemapChecks(true), EXISTS_RULE, "sitemap-exists");

    expect(check).toBeDefined();
    expect(check!.status).toBe("info");
    expect(check!.message).not.toContain("No XML sitemap found");
  });

  test("a completed walk that found nothing still fails", async () => {
    // The other half: the flag must not blanket-suppress a real finding, or the
    // fix would trade a false positive for a false negative.
    const check = named(await sitemapChecks(false), EXISTS_RULE, "sitemap-exists");

    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    expect(check!.message).toBe("No XML sitemap found");
  });

  test("sitemap-valid says the check did not complete, not that there was nothing", async () => {
    // The other rule that reads an empty sitemap set. "No sitemap to validate"
    // reads as a finished check; a truncated walk finished nothing.
    const check = named(await sitemapChecks(true), VALID_RULE, "sitemap-valid");

    expect(check).toBeDefined();
    expect(check!.status).toBe("info");
    expect(check!.message).toContain("did not complete");
  });

  test("sitemap-valid still skips normally when the walk completed", async () => {
    const check = named(await sitemapChecks(false), VALID_RULE, "sitemap-valid");

    expect(check).toBeDefined();
    expect(check!.status).toBe("skipped");
    expect(check!.message).toBe("No sitemap to validate");
  });
});
