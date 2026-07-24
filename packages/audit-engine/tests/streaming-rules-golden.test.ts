// GOLDEN INVARIANT (#1021, PR-E — the MERGE GATE): `runStreamingRules` (v2) is
// byte-identical to `runRulesOnStorage` (v1) over the same crawl DB and the real
// rule set. Both run over synthetic fixtures; the three assertions per fixture are
// the handoff's gate:
//   1. calculateHealthScore(v1.ruleResultsMap) === calculateHealthScore(v2.ruleResultsMap)
//   2. the (ruleId, checkName, status, pageUrl) finding multiset is identical
//   3. calculateHealthScoreFromTallies(v2.tallies, penalty) === v1's health score
//      (proving the streamed fold-to-tallies scoring path matches v1 too).
//
// Coverage: a rich-issue-mix model (redirects / orphans / duplicates / broken
// links / noindex-in-sitemap — exercises the non-HTML exclusion + many site
// rules), an all-clean model (every page passes), and an edge variant that injects
// a 4xx error page (the EMPTY_PARSED_PAGE append) and a 503 WAF-challenge page (the
// WAF exclusion + advisory site check) so v2's DUPLICATED universe-assembly block
// is ground-truthed against v1's.
//
// Assets are held identical (empty) across both paths: they are a shared INPUT to
// v1 and v2, so holding them constant isolates the rule-engine parity from network
// resource-fetch nondeterminism (fetchResourceAssets is covered by its own tests).

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { generateSiteModel, writeCrawlToStorage } from "@squirrelscan/synthetic-site";
import type { SQLiteStorage } from "@squirrelscan/crawler";
import type { Config } from "@squirrelscan/config";
import type {
  PageRecord,
  ResponseHeaders,
  RuleRunResult,
  SecurityHeaders,
} from "@squirrelscan/core-contracts";
import {
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
} from "@squirrelscan/utils/constants";

import {
  buildSiteContext,
  runRulesOnStorage,
  runStreamingRules,
  type PreFetchedAssets,
  type RuleExecutionResult,
  type StreamingRuleExecutionResult,
} from "../src/adapter";
import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
  type RuleTally,
} from "../src/scoring";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

// enable ["*"] turns on the WHOLE rule set (filterRules defaults every rule to
// disabled) so the parity check is over the real rules, not an empty run. No
// integrity probes (soft-404 confirm / cloaking) — keeps the run hermetic (no
// network) and deterministic; v1 and v2 use the identical config either way.
const CONFIG = { rule_options: {}, rules: { enable: ["*"] } } as unknown as Config;

const EMPTY_ASSETS: PreFetchedAssets = {
  resourceSizes: { css: [], images: [] },
  scripts: [],
  pdfSizes: [],
  sitemapUrlStatuses: [],
};

// The (ruleId, checkName, status, pageUrl) finding multiset — order-independent
// (sorted), duplicate-preserving. The handoff's finding-set identity.
function findingTuples(map: Map<string, RuleRunResult>): string[] {
  const out: string[] = [];
  for (const [ruleId, rr] of map) {
    for (const check of rr.checks) {
      out.push(`${ruleId}|${check.name}|${check.status}|${check.pageUrl ?? ""}`);
    }
  }
  return out.sort();
}

function scoreOf(map: Map<string, RuleRunResult>) {
  return calculateHealthScore({ results: map });
}

// Score the streamed tallies the PR-F way: penalty inputs are the two critical
// rules (robots/sitemap) pulled from the same accumulated ruleResultsMap.
function talliesScore(
  tallies: Map<string, RuleTally>,
  ruleResultsMap: Map<string, RuleRunResult>,
) {
  const penalty = new Map<string, RuleRunResult>();
  for (const id of [RULE_ID_ROBOTS_TXT, RULE_ID_SITEMAP_EXISTS]) {
    const rr = ruleResultsMap.get(id);
    if (rr) penalty.set(id, rr);
  }
  return calculateHealthScoreFromTallies(tallies, penalty);
}

async function runV1(storage: SQLiteStorage, crawlId: string): Promise<RuleExecutionResult> {
  const pages = await run(storage.getPages(crawlId));
  const siteContext = await run(buildSiteContext(pages));
  return run(runRulesOnStorage(storage, crawlId, siteContext, CONFIG, EMPTY_ASSETS));
}

async function runV2(
  storage: SQLiteStorage,
  crawlId: string,
): Promise<StreamingRuleExecutionResult> {
  return run(runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 8 }));
}

// Assert full byte-identity for one crawl DB: v1 vs v2 ruleResultsMap score +
// finding set, plus the streamed tally score against v1.
async function assertParity(storage: SQLiteStorage, crawlId: string) {
  const v1 = await runV1(storage, crawlId);
  const v2 = await runV2(storage, crawlId);

  const v1Score = scoreOf(v1.ruleResultsMap);
  expect(scoreOf(v2.ruleResultsMap)).toEqual(v1Score);
  expect(findingTuples(v2.ruleResultsMap)).toEqual(findingTuples(v1.ruleResultsMap));
  expect(talliesScore(v2.tallies, v2.ruleResultsMap)).toEqual(v1Score);
  return { v1, v2, v1Score };
}

const EMPTY_HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  vary: null,
  etag: null,
  server: null,
  lastModified: null,
  link: null,
  serverTiming: null,
  age: null,
  xCache: null,
  cfCacheStatus: null,
  xVercelCache: null,
  altSvc: null,
  acceptRanges: null,
};
const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function injectedPage(over: Partial<PageRecord> & { url: string; status: number }): PageRecord {
  return {
    url: over.url,
    normalizedUrl: over.url,
    finalUrl: over.url,
    depth: 1,
    status: over.status,
    contentType: over.contentType ?? null,
    sizeBytes: over.html ? Buffer.byteLength(over.html, "utf8") : 0,
    loadTimeMs: 1,
    fetchedAt: 1,
    etag: null,
    lastModified: null,
    contentHash: "inj",
    html: over.html ?? null,
    parsedData: null,
    headers: EMPTY_HEADERS,
    securityHeaders: EMPTY_SECURITY_HEADERS,
    ...over,
  };
}

// runStreamingRules re-parses each page ~3× (Pass-1 scalars, Pass-2 page rules,
// site-pass re-materialization), so v1+v2 over a fixture is CPU-heavy — generous
// per-test timeouts keep it robust on a loaded CI runner (default is 5s). The
// re-parse cost collapses in E-E2 (collectors replace the site-pass materialization).
const T = 30_000;

describe("runStreamingRules — GOLDEN INVARIANT vs runRulesOnStorage", () => {
  test("rich-issue-mix crawl: byte-identical score + findings + tally score", async () => {
    const model = generateSiteModel({ seed: 3, pageCount: 60 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");

    const { v1Score } = await assertParity(storage, crawlId);
    // Sanity: the rich model actually produced a scored, non-perfect audit.
    expect(v1Score.overall).not.toBeNull();

    await run(storage.close());
  }, T);

  test("all-clean crawl: byte-identical (every page passes)", async () => {
    const model = generateSiteModel({
      seed: 5,
      pageCount: 40,
      cleanRatio: 1,
      issues: {
        longH1: false,
        oversizeTitle: false,
        oversizeDescription: false,
        longUrls: false,
        duplicateTitles: false,
        duplicateDescriptions: false,
        orphanPages: false,
        redirectChains: false,
        brokenLinks: false,
        noindexInSitemap: false,
      },
    });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");

    await assertParity(storage, crawlId);

    await run(storage.close());
  }, T);

  test("edge crawl: injected 4xx (EMPTY_PARSED_PAGE append) + 503 WAF page stay byte-identical", async () => {
    const model = generateSiteModel({ seed: 9, pageCount: 30 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");

    // 4xx with no body → non-HTML → appended as an EMPTY_PARSED_PAGE error page.
    await run(
      storage.upsertPage(
        crawlId,
        injectedPage({ url: "http://synthetic.test/missing-page", status: 404 }),
      ),
    );
    // A 503 WAF-challenge interstitial → excluded from page scoring + surfaced as
    // the advisory "WAF challenge pages detected" site check.
    await run(
      storage.upsertPage(
        crawlId,
        injectedPage({
          url: "http://synthetic.test/blocked",
          status: 503,
          contentType: "text/html",
          html: "<html><head><title>Just a moment...</title></head><body>Just a moment...</body></html>",
        }),
      ),
    );

    const { v1 } = await assertParity(storage, crawlId);
    // The WAF advisory check must actually be present (proves the branch ran).
    expect(v1.ruleResultsMap.has("crawl/waf-challenge-pages")).toBe(true);

    await run(storage.close());
  }, T);

  test("batch size does not change the streamed result (batch 3 ≡ batch 200)", async () => {
    const model = generateSiteModel({ seed: 12, pageCount: 24 });
    const { storage, crawlId } = await writeCrawlToStorage(model, ":memory:");

    const a = await run(
      runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 3 }),
    );
    const b = await run(
      runStreamingRules(storage, crawlId, CONFIG, EMPTY_ASSETS, undefined, { batchSize: 200 }),
    );

    expect(scoreOf(a.ruleResultsMap)).toEqual(scoreOf(b.ruleResultsMap));
    expect(findingTuples(a.ruleResultsMap)).toEqual(findingTuples(b.ruleResultsMap));
    // Small batch keeps page-stream DOM residency low; a big batch holds more at once.
    expect(a.peakLiveDocsPageStream).toBeLessThanOrEqual(3);
    expect(a.peakLiveDocsPageStream).toBeLessThan(b.peakLiveDocsPageStream);

    await run(storage.close());
  }, T);
});
