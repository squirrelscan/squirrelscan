// Complete-store merge cost against the site's carried backlog (#497).
//
// Runs one `runCloudSmartAudits` publish in complete-store mode with the
// untouched-carried split, the way the hosting finalize drives it, against an
// in-memory store. The same run (2,000 fresh findings on 200 crawled pages) is
// measured on a site holding no carried findings and on one holding
// `--carried` of them on untouched pages. The store's aggregate and sample are
// computed BEFORE the clock starts: in production they are one SQL scan, so
// what is timed here is the engine's share of the publish.
//
// One arm per process, so neither inherits the other's heap or JIT state.
// Alternate the arms and take the minimum (benchmarks/README.md):
//
//   for i in 1 2 3 4 5; do
//     bun run scripts/bench-untouched-carried.ts --carried=0
//     bun run scripts/bench-untouched-carried.ts --carried=250000
//   done
//
// Prints one JSON line: CPU and wall time of the merge, the store calls it made
// and the rows it handed them (the hosting side turns each call into one or more
// batched statements), and the size of the serialized union, which is what the
// report is rendered from.

import type { CheckResult, PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import {
  aggregateUntouchedCarried,
  type UntouchedCarriedPage,
  type UntouchedSamplePage,
} from "../src/complete-store-fold";
import { runCloudSmartAudits, type OpenFindingPage } from "../src/merge-promise";
import { calculateHealthScoreFromTallies } from "../src/scoring";
import { BenchStore } from "./bench-store";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const CARRIED = arg("carried", 250_000);
const FRESH = arg("fresh", 2_000);
const CRAWLED = arg("crawled", 200);
const PER_PAGE = arg("per-page", 10);
const RULES = arg("rules", 40);

const SITE = "web_bench";
const AUDIT = "audit_now";
const PRIOR = "audit_prior";
const T_PRIOR = 1_690_000_000_000;
const T_NOW = 1_700_000_000_000;

const ruleId = (r: number) => `content/rule-${String(r).padStart(2, "0")}`;
const meta = (r: number): RuleRunResult["meta"] => ({
  id: ruleId(r),
  name: `Bench rule ${r}`,
  description: "A page-scope rule used to size the complete-store merge",
  category: "content",
  scope: "page",
  severity: r % 9 === 0 ? "info" : r % 5 === 0 ? "error" : "warning",
  weight: 10,
});
const ruleResults: Record<string, { meta: RuleRunResult["meta"]; checks: CheckResult[] }> = {};
for (let r = 0; r < RULES; r++) ruleResults[ruleId(r)] = { meta: meta(r), checks: [] };

// Crawled pages sort before the backlog, as `/a/` before `/b/`.
const crawledUrl = (p: number) => `https://bench.test/a/${String(p).padStart(6, "0")}`;
const backlogUrl = (p: number) => `https://bench.test/b/${String(p).padStart(6, "0")}`;

function row(url: string, i: number, auditId: string): PageFindingRecord {
  const r = i % RULES;
  const t = auditId === AUDIT ? T_NOW : T_PRIOR;
  return {
    siteKey: SITE,
    normalizedUrl: url,
    ruleId: ruleId(r),
    checkName: `check-${i % 3}`,
    locator: `item-${i}`,
    status: i % 4 === 0 ? "warn" : "fail",
    severity: r % 5 === 0 ? "error" : "warning",
    message: `The element at position ${i} on this page does not satisfy rule ${r}`,
    value: `observed-value-${i}`,
    expected: `expected-value-${i}`,
    payload: JSON.stringify({
      items: [{ id: `item-${i}`, label: `Element #${i} in the document body`, sourcePages: [url] }],
      details: { additional: i % 7 },
      i,
    }),
    fingerprint: `fp-${i}`,
    firstSeenAt: t,
    lastSeenCrawlId: auditId,
    lastSeenAt: t,
    provenance: auditId === AUDIT ? "fresh" : "carried",
    state: "open",
  };
}

function sitePage(url: string, auditId: string): SitePageRecord {
  return {
    siteKey: SITE,
    normalizedUrl: url,
    lastStatus: 200,
    state: "active",
    lastSeenCrawlId: auditId,
    lastSeenAt: auditId === AUDIT ? T_NOW : T_PRIOR,
  };
}

// ── fixture (untimed) ───────────────────────────────────────────────────────
const crawled: string[] = [];
const touched: OpenFindingPage[] = [];
const freshPerPage = Math.ceil(FRESH / CRAWLED);
for (let p = 0; p < CRAWLED; p++) {
  const url = crawledUrl(p);
  crawled.push(url);
  const fresh: PageFindingRecord[] = [];
  for (let i = 0; i < freshPerPage; i++) fresh.push(row(url, p * freshPerPage + i, AUDIT));
  touched.push({ normalizedUrl: url, fresh, prior: [] });
}

const backlogPages = Math.ceil(CARRIED / PER_PAGE);
const priorPages: SitePageRecord[] = crawled.map((u) => sitePage(u, PRIOR));
const untouched: UntouchedCarriedPage[] = [];
for (let p = 0; p < backlogPages; p++) {
  const url = backlogUrl(p);
  priorPages.push(sitePage(url, PRIOR));
  const rows: PageFindingRecord[] = [];
  for (let i = 0; i < PER_PAGE && p * PER_PAGE + i < CARRIED; i++) rows.push(row(url, p * PER_PAGE + i, PRIOR));
  untouched.push({ normalizedUrl: url, rows, rendered: true, active: true });
}
// What the store's single scan returns.
const { aggregate, sample } = aggregateUntouchedCarried(untouched);
untouched.length = 0;

const store = new BenchStore(priorPages);

// Touched pages first, then the backlog's sample: cursor order.
async function* pages(): AsyncGenerator<OpenFindingPage | UntouchedSamplePage> {
  for (const page of touched) yield page;
  for (const page of sample) yield page;
}

Bun.gc(true);

// ── timed ───────────────────────────────────────────────────────────────────
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const result = await runCloudSmartAudits({
  store,
  siteKey: SITE,
  crawlId: AUDIT,
  ruleResults,
  pageStatuses: crawled.map((url) => ({ url, status: 200 })),
  now: T_NOW,
  completeStore: {
    crawledUrls: crawled,
    untouchedCarried: async () => {
      store.storeCalls += 1;
      return { pages: pages(), aggregate };
    },
  },
});
const score = calculateHealthScoreFromTallies(result.scoringTallies!, result.unionRuleResults);
const wallMs = performance.now() - wall0;
const cpu = process.cpuUsage(cpu0);
const union = JSON.stringify([...result.unionRuleResults]);
// Everything a caller reads, hashed, so two builds can be compared byte for byte.
const digest = new Bun.CryptoHasher("sha256")
  .update(JSON.stringify([[...result.scoringTallies!], score, result.coverage, result.persistedFindings]))
  .update(union)
  .digest("hex")
  .slice(0, 16);

console.log(
  JSON.stringify({
    carried: CARRIED,
    fresh: freshPerPage * CRAWLED,
    sitePages: priorPages.length,
    sampleRows: sample.reduce((n, p) => n + p.sample.length, 0),
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
    wallMs: Number(wallMs.toFixed(1)),
    storeCalls: store.storeCalls,
    rowsWritten: store.rowsWritten,
    unionBytes: union.length,
    digest,
    overall: score.overall,
    carriedFindings: result.coverage.carriedFindings,
  }),
);
