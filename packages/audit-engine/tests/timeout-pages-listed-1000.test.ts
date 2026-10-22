// pub#1000: a rule that timed out on SOME pages carries only those pages' prior
// findings. The in-process timeout path leaves one skipped `<rule>-error` row per
// timed-out page (each stamped with its page by the engine), which the resolution
// signal lists under the rule-wide key `<rule>|*`; a page the rule completed is
// not listed, so its prior finding still resolves. Driven through the real
// engine with the rule time budget at 1 ms, in both engines, and again after the
// publish fold that merges the per-page rows into one aggregate.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { CheckResult, PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { resolutionRuleKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { DEFAULT_FOLD_LIMITS, foldOverflowChecks } from "@squirrelscan/rules/fold";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
} from "../src/adapter";

const BASE = "https://shop.example.com";
const RULE = "content/hidden-text";

const CONFIG = {
  rule_options: {},
  // Below the 1000 ms the schema allows, so a real rule times out on a real page
  // without a multi-second fixture.
  rules: { enable: [RULE], time_budget_ms: 1 },
} as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>);

const BIG_BODY = `<!doctype html><html lang="en"><head><title>Big page</title></head><body>${'<div style="display:none">hidden filler text for the rule to read</div><p>visible copy</p>'.repeat(
  12_000,
)}</body></html>`;
const SMALL_BODY =
  '<!doctype html><html lang="en"><head><title>Small</title></head><body><p>hi</p></body></html>';

function pageRecord(path: string, body: string): PageRecord {
  const url = `${BASE}${path}`;
  return {
    url,
    normalizedUrl: url,
    finalUrl: url,
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: body.length,
    loadTimeMs: 10,
    fetchedAt: Date.now(),
    etag: null,
    lastModified: null,
    contentHash: `hash-${path}`,
    html: body,
    parsedData: null,
    headers: {},
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

async function audit(engine: Engine, config: Config = CONFIG, bigBody: string = BIG_BODY) {
  const storage = new SQLiteStorage(":memory:");
  return run(
    Effect.gen(function* () {
      yield* storage.init();
      const crawlId = yield* storage.createCrawl({
        baseUrl: BASE,
        seedUrl: `${BASE}/`,
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
      yield* storage.upsertPage(crawlId, pageRecord("/", SMALL_BODY));
      yield* storage.upsertPage(crawlId, pageRecord("/big-a", bigBody));
      yield* storage.upsertPage(crawlId, pageRecord("/big-b", bigBody));

      if (engine === "streaming") {
        return yield* runStreamingRules(storage, crawlId, config, EMPTY_ASSETS, undefined, {
          batchSize: 1,
        });
      }
      const stored = yield* storage.getPages(crawlId);
      const siteContext = yield* buildSiteContext(stored);
      return yield* runRulesOnStorage(storage, crawlId, siteContext, config, EMPTY_ASSETS);
    }).pipe(Effect.ensuring(storage.close().pipe(Effect.orDie))),
  );
}

const CRAWLED = [`${BASE}/`, `${BASE}/big-a`, `${BASE}/big-b`];
const hashes = (urls: string[]) => urls.map((u) => resolutionUrlHash(normalizePageUrl(u))).sort();

// The 1 ms budget can also catch the small page on a cold start, so the pages
// that timed out are read from the rows rather than assumed.
const timedOutPages = (checks: CheckResult[]): string[] =>
  checks.filter((c) => c.skipReason === "rule-timed-out").map((c) => c.pageUrl!);

describe("a rule that timed out on some pages lists only those (pub#1000)", () => {
  for (const engine of ["v1", "streaming"] as const) {
    test(`${engine}: the rule-wide key lists exactly the timed-out pages`, async () => {
      const result = await audit(engine);
      const checks = result.ruleResultsMap.get(RULE)?.checks ?? [];
      const timed = timedOutPages(checks);
      // The premise: the rule timed out on both big pages.
      expect(timed).toContain(`${BASE}/big-a`);
      expect(timed).toContain(`${BASE}/big-b`);
      for (const url of timed)
        expect(checks.some((c) => c.pageUrl === url && c.skipReason)).toBe(true);

      const signal = buildResolutionSignal({ [RULE]: { checks } } as never, CRAWLED)!;
      expect([...(signal.notEvaluated?.[resolutionRuleKey(RULE)] ?? [])].sort()).toEqual(
        hashes(timed),
      );
    }, 60_000);

    test(`${engine}: after the publish fold the aggregate still lists exactly those pages`, async () => {
      const result = await audit(engine);
      const checks = result.ruleResultsMap.get(RULE)?.checks ?? [];
      const timed = timedOutPages(checks);
      const folded = foldOverflowChecks(checks, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 });
      const aggregate = folded.find((c) => c.skipReason === "rule-timed-out");
      expect(aggregate?.pages?.map(normalizePageUrl).sort()).toEqual(
        timed.map(normalizePageUrl).sort(),
      );

      const signal = buildResolutionSignal({ [RULE]: { checks: folded } } as never, CRAWLED)!;
      expect([...(signal.notEvaluated?.[resolutionRuleKey(RULE)] ?? [])].sort()).toEqual(
        hashes(timed),
      );
    }, 60_000);
  }
});

describe("a clipped page list is the safe direction (pub#1000)", () => {
  test("a folded timeout row clipped past its cap marks every crawled page", () => {
    const aggregate: CheckResult = {
      name: `${RULE}-error`,
      status: "skipped",
      skipReason: "rule-timed-out",
      message: "Rule not evaluated: exceeded its time budget (+4 more pages)",
      pages: [`${BASE}/big-a`],
      details: { aggregated: true, occurrences: 5, pagesTruncated: 5 },
    };
    const signal = buildResolutionSignal({ [RULE]: { checks: [aggregate] } } as never, CRAWLED)!;
    expect(signal.notEvaluated?.[resolutionRuleKey(RULE)]).toHaveLength(CRAWLED.length);
  });
});
