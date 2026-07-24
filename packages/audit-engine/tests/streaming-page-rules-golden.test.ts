// GOLDEN INVARIANT (#1021, PR-E §1): the STREAMED page-rule pass produces
// byte-identical per-page results + folded per-rule tallies to a RESIDENT loop
// that runs the same page rules over all pages at once — over a real synthetic
// crawl and the real rule set. This proves streaming the page pass (with per-page
// DOM-drop) changes memory/timing, not results. Also asserts DOM residency stays
// batch-bounded (peakLiveDocs ≤ batch).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import { createRunner, type RuleRunner, type SiteData } from "@squirrelscan/rules";
import type { SQLiteStorage } from "@squirrelscan/crawler";

import { buildSiteContext, buildHeadersMap, isRenderedFetch } from "../src/adapter";
import { isAuditablePage } from "../src/page-features";
import {
  foldRuleResultIntoTallies,
  type RuleTally,
} from "../src/scoring";
import { streamPageRules } from "../src/streaming";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

// enable ["*"] turns on the whole rule set — filterRules defaults every rule to
// disabled, so an empty `rules` would make the resident-vs-streamed comparison
// trivially match on empty results. With the real rules on, the fold/pageResults
// parity is actually exercised.
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } };

// Reference resident loop: parse ALL pages up front, run page rules over each
// auditable page, fold into per-rule tallies. Byte-identical target for streaming.
async function runResidentPageRules(
  storage: SQLiteStorage,
  crawlId: string,
  runner: RuleRunner,
  siteData: SiteData
) {
  const pages = await run(storage.getPages(crawlId));
  const ctx = await run(buildSiteContext(pages));
  const pageResults = new Map<string, unknown[]>();
  const tallies = new Map<string, RuleTally>();
  for (const { page, parsed } of ctx) {
    if (!parsed) continue;
    if (!isAuditablePage(page)) continue;
    const result = await runner.runPageRules(
      {
        url: page.url,
        html: page.html!,
        statusCode: page.status,
        loadTime: page.loadTimeMs,
        ttfb: page.ttfb,
        downloadTime: page.downloadTime,
        headers: buildHeadersMap(page),
        parsed,
        finalUrl: page.finalUrl,
        redirectChain: page.redirectChain,
        rendered: isRenderedFetch(page.fetcherId),
      },
      siteData
    );
    const pageUrl = page.normalizedUrl;
    for (const [ruleId, rr] of result.ruleResults) {
      for (const check of rr.checks) if (!check.pageUrl) check.pageUrl = pageUrl;
      foldRuleResultIntoTallies(tallies, ruleId, rr);
    }
    pageResults.set(pageUrl, result.checks);
  }
  return { pageResults, tallies };
}

async function fixture(seed: number, pageCount: number) {
  const model = generateSiteModel({ seed, pageCount });
  const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");
  return { storage, crawlId };
}

// Page rules read only non-`pages` site fields; both paths get this identical
// minimal SiteData (pages:[] for streaming, ignored by page rules).
function siteData(): SiteData {
  return { baseUrl: "http://synthetic.test", pages: [], robotsTxt: null, sitemaps: null };
}

describe("streaming page-rule pass — GOLDEN INVARIANT vs resident loop", () => {
  test("identical folded tallies + page results over a 40-page synthetic crawl", async () => {
    const { storage, crawlId } = await fixture(7, 40);
    const runner = createRunner(CONFIG);

    const resident = await runResidentPageRules(storage, crawlId, runner, siteData());
    const streamed = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), { batchSize: 8 })
    );

    // Per-rule folded tallies must match exactly.
    expect([...streamed.tallies.keys()].sort()).toEqual([...resident.tallies.keys()].sort());
    for (const [ruleId, rt] of resident.tallies) {
      expect(streamed.tallies.get(ruleId)?.tally).toEqual(rt.tally);
    }
    // Per-page flat check lists must match exactly.
    expect([...streamed.pageResults.keys()].sort()).toEqual(
      [...resident.pageResults.keys()].sort()
    );
    for (const [url, checks] of resident.pageResults) {
      expect(streamed.pageResults.get(url)).toEqual(checks as never);
    }

    // Residency stayed batch-bounded (≤ batchSize live DOMs at any point).
    expect(streamed.peakLiveDocs).toBeLessThanOrEqual(8);
    // Feature extraction ran on the auditable pages.
    expect(streamed.extractedCount).toBe(streamed.pageUrls.length);

    await run(storage.close());
  });

  test("batch size does not change results (batch 3 ≡ batch 200)", async () => {
    const { storage, crawlId } = await fixture(11, 25);
    const a = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), { batchSize: 3 })
    );
    const b = await run(
      streamPageRules(storage, crawlId, createRunner(CONFIG), siteData(), { batchSize: 200 })
    );
    for (const [ruleId, rt] of a.tallies) {
      expect(b.tallies.get(ruleId)?.tally).toEqual(rt.tally);
    }
    expect(a.pageUrls.sort()).toEqual(b.pageUrls.sort());
    await run(storage.close());
  });
});
