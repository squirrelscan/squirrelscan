// Per-page retention of each accumulator the streamed page loop keeps (#1860).
//
// Mirrors streamPageRules' retention exactly — the same detach calls, the same
// three check maps, the same collected signal — but with each accumulator
// switchable, so the per-page cost of one term is the slope of that mode minus
// the slope of the retain-nothing control.
//
// The control is not optional. This loop parses, runs the real rule set and
// releases each batch; that alone moves heapUsed+external by hundreds of MB on
// a real fixture, and dividing that by page count invents a per-page term that
// is not there (#237's universe measurement made the same subtraction).
//
//   bun run scripts/page-loop-census.ts --db /tmp/real150.sqlite --mode full
//
// modes: none | checks | collected | full

import { SQLiteStorage } from "@squirrelscan/crawler";
import {
  buildCollectedPageSignal,
  createRunner,
  mergeRuleRunResult,
  type CollectedPageSignal,
  type RuleRunResult,
  type SiteData,
} from "@squirrelscan/rules";
import type { CheckResult } from "@squirrelscan/core-contracts";
import { Effect } from "effect";

import { buildHeadersMap, buildSiteContext, isRenderedFetch, releaseSiteContextDocuments } from "../src/adapter";
import { collectDroppedBatch } from "../src/batch-gc";
import { detachFromPage } from "../src/detach";
import { isAuditablePage } from "../src/page-features";
import { foldRuleResultIntoTallies, type RuleTally } from "../src/scoring";

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

const DB = arg("db", "");
const MODE = arg("mode", "full");
const BATCH = Number.parseInt(arg("batch", "50"), 10);
const KEEP_CHECKS = MODE === "checks" || MODE === "full";
const KEEP_COLLECTED = MODE === "collected" || MODE === "full";

const CONFIG = { rule_options: {}, rules: { enable: ["*"] } };
const SITE_DATA: SiteData = {
  baseUrl: "https://www.drscholls.com",
  pages: [],
  robotsTxt: null,
  sitemaps: null,
};

function retained(): number {
  Bun.gc(true);
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

const storage = new SQLiteStorage(DB);
await run(storage.init());
const crawls = await run(storage.listCrawls(1));
const crawlId = (crawls as Array<{ id: string }>)[0]!.id;
const runner = createRunner(CONFIG);

// The three maps streamPageRules keeps, plus the collected signals array.
const pageResults = new Map<string, CheckResult[]>();
const pageRuleResults = new Map<string, Map<string, CheckResult[]>>();
const ruleResultsMap = new Map<string, RuleRunResult>();
const tallies = new Map<string, RuleTally>();
const collectedPages: CollectedPageSignal[] = [];

const before = retained();
let pages = 0;

for (let offset = 0; ; offset += BATCH) {
  const batch = await run(storage.getPages(crawlId, { limit: BATCH, offset }));
  if (batch.length === 0) break;
  const ctx = await run(buildSiteContext(batch));

  for (const { page, parsed } of ctx) {
    if (!parsed) continue;
    if (!isAuditablePage(page)) {
      parsed.document = null;
      continue;
    }
    const raw = await runner.runPageRules(
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
      SITE_DATA,
    );

    if (KEEP_CHECKS) {
      const byRule = [...raw.ruleResults];
      const detached = detachFromPage(
        { checks: raw.checks, ruleChecks: byRule.map(([, rr]) => rr.checks) },
        "page-rules",
      );
      const pageUrl = page.normalizedUrl;
      pageResults.set(pageUrl, detached.checks);
      const perRule = new Map<string, CheckResult[]>();
      byRule.forEach(([ruleId], i) => perRule.set(ruleId, detached.ruleChecks[i]!));
      pageRuleResults.set(pageUrl, perRule);
      byRule.forEach(([ruleId, rr], i) => {
        const withChecks = { ...rr, checks: detached.ruleChecks[i]! } as RuleRunResult;
        for (const check of withChecks.checks) if (!check.pageUrl) check.pageUrl = pageUrl;
        mergeRuleRunResult(ruleResultsMap, ruleId, withChecks);
        foldRuleResultIntoTallies(tallies, ruleId, withChecks);
      });
    }

    if (KEEP_COLLECTED) {
      collectedPages.push(
        detachFromPage(
          buildCollectedPageSignal({ url: page.normalizedUrl, finalUrl: page.finalUrl, parsed }),
          "collected-signal",
        ),
      );
    }

    parsed.document = null;
    pages++;
  }

  releaseSiteContextDocuments(ctx);
  collectDroppedBatch();
  if (batch.length < BATCH) break;
}

const after = retained();

// Per-term cost by DROPPING each accumulator in turn and re-measuring, all
// inside one process. A between-process comparison of two modes carries the
// whole run's variance (±50 MB here, which at a 100-page spread is ±500 KB/page
// — the same order as the signal); a within-run difference does not.
//
// The three check maps are dropped together because they reference the SAME
// check objects: freeing one of them alone frees nothing.
const counts = {
  checkPages: pageResults.size,
  collected: collectedPages.length,
  rules: ruleResultsMap.size,
  tallies: tallies.size,
};
const drops: Array<[string, number]> = [];
let prev = after;

collectedPages.length = 0;
let now = retained();
drops.push(["collected-signals", prev - now]);
prev = now;

pageResults.clear();
pageRuleResults.clear();
ruleResultsMap.clear();
now = retained();
drops.push(["page-check-maps", prev - now]);
prev = now;

tallies.clear();
now = retained();
drops.push(["tallies", prev - now]);

const KB = 1024;
console.log(
  JSON.stringify({
    db: DB.split("/").pop(),
    mode: MODE,
    pages,
    heldMB: Math.round((after - before) / 1024 / 1024),
    ...counts,
    perPageKB: Object.fromEntries(
      drops.map(([name, bytes]) => [name, Math.round(bytes / pages / KB)]),
    ),
  }),
);
await run(storage.close());
