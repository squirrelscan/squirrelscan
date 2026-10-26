// pub#971 end-to-end: a page rule that times out in an audit leaves ONE
// `<rule>-timeouts` info row in the results the CLI stores and the report is
// built from. The row used to be returned on `runSiteRules().checks` only, a
// list neither the store nor the report reads, so the documented place a timeout
// surfaces (the per-page row is a skip since #969) was never written.
//
// Driven through the real engine entry points the audit uses, with the rule time
// budget at 1 ms so a real rule over a real page times out. A control page makes
// sure the rule still runs fine where it is fast.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { SQLiteStorage } from "@squirrelscan/crawler";

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
  12_000
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

describe("the <rule>-timeouts row reaches the stored results (pub#971)", () => {
  for (const engine of ["v1", "streaming"] as const) {
    test(`${engine}: one info row in siteRuleResults and ruleResultsMap`, async () => {
      const result = await audit(engine);

      // The premise: the rule really did time out on the big pages.
      const stored = result.siteRuleResults.get(RULE) ?? [];
      const rows = stored.filter((c) => c.name === `${RULE}-timeouts`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "info",
        details: { timedOut: true, ruleId: RULE, budgetMs: 1 },
      });
      const pagesNotChecked = (rows[0]!.details as { pagesNotChecked: number }).pagesNotChecked;
      expect(pagesNotChecked).toBeGreaterThanOrEqual(1);
      expect((rows[0]!.details as { maxElapsedMs?: number }).maxElapsedMs).toBeGreaterThanOrEqual(1);

      // And in the per-rule results the report is built from.
      const inReport = result.ruleResultsMap.get(RULE)?.checks.filter((c) => c.name === `${RULE}-timeouts`);
      expect(inReport).toHaveLength(1);
      // No failed check for a timeout, on any page.
      for (const checks of result.pageRuleResults.values()) {
        for (const [, list] of checks) expect(list.some((c) => c.status === "fail")).toBe(false);
      }
    }, 60_000);
  }
});

describe("a page-time extractor timeout leaves the row too (pub#971)", () => {
  test("security/leaked-secrets: one info row with the pages it did not scan, and no fail", async () => {
    const script = `<script>${"var token = 'abcdefghijklmnopqrstuvwxyz0123456789';\n".repeat(60_000)}</script>`;
    const body = `<!doctype html><html lang="en"><head><title>Scripts</title></head><body>${script}</body></html>`;
    const config = {
      rule_options: {},
      rules: { enable: ["security/leaked-secrets"], time_budget_ms: 1 },
    } as unknown as Config;
    const result = await audit("streaming", config, body);

    const checks = result.siteRuleResults.get("security/leaked-secrets") ?? [];
    const rows = checks.filter((c) => c.name === "security/leaked-secrets-timeouts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "info", details: { timedOut: true, pagesNotChecked: 2 } });
    expect(checks.some((c) => c.status === "fail")).toBe(false);
    expect(checks.filter((c) => c.name === "security/leaked-secrets-error").map((c) => c.status)).toEqual([
      "skipped",
      "skipped",
    ]);
  }, 60_000);
});
