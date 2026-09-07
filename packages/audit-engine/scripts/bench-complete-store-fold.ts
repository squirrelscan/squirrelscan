// Complete-store finalize memory bench (#1873).
//
// Measures the two ways of scoring a chunked publish off the COMPLETE findings:
//
//   --mode=materialized  the pre-#1873 path: every page_findings row resident as a
//                        PageFindingRecord[] (loadIngestedFindings), then
//                        reconstructCompleteResults → buildScoringResultsFromMerged
//                        → calculateHealthScore. This is what Cloudflare killed
//                        with `exceededMemory` at 43,470 findings.
//   --mode=bounded       the #1873 path: findings arrive one page at a time from a
//                        cursor and are folded into per-rule tallies, then
//                        calculateHealthScoreFromTallies.
//
// Peak memory is only honest as a fresh process's max RSS (a JSC heapUsed delta
// reported a 4 MiB JSON.parse as +0.00 MiB — see the publish-zod-clamp
// measurement), so run each mode under /usr/bin/time and compare `maximum
// resident set size`:
//
//   /usr/bin/time -l bun run scripts/bench-complete-store-fold.ts --mode=materialized
//   /usr/bin/time -l bun run scripts/bench-complete-store-fold.ts --mode=bounded
//
// Defaults reproduce the #1873 acceptance shape: 60,000 findings over 500 pages.
// The absolute numbers are Bun/JSC on the host, not workerd/V8 in a 128 MB
// isolate — the RATIO is what transfers.

import type { CheckResult, PageFindingRecord } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import { foldCompleteStoreTallies } from "../src/complete-store-fold";
import { reconstructCompleteResults } from "../src/reconstruct";
import {
  buildScoringResultsFromMerged,
  calculateHealthScore,
  calculateHealthScoreFromTallies,
} from "../src/scoring";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const mode =
  process.argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length) ?? "bounded";
const PAGES = arg("pages", 500);
const FINDINGS = arg("findings", 60_000);
const RULES = arg("rules", 40);

const ruleId = (r: number) => `content/rule-${r}`;
const pageUrl = (p: number) => `https://bench.test/section-${p % 20}/page-${p}?variant=${p % 3}`;

const meta = (r: number): RuleRunResult["meta"] => ({
  id: ruleId(r),
  name: `Bench rule ${r}`,
  description: "A page-scope rule used to size the finalize fold",
  category: "content",
  scope: "page",
  severity: r % 5 === 0 ? "error" : "warning",
  weight: 10,
});

/** The staged shell: rule META plus a bounded display sample, as the container stages it. */
const ruleResults: Record<string, { meta: RuleRunResult["meta"]; checks: CheckResult[] }> = {};
for (let r = 0; r < RULES; r++) ruleResults[ruleId(r)] = { meta: meta(r), checks: [] };

const crawledUrls = new Set<string>();
for (let p = 0; p < PAGES; p++) crawledUrls.add(pageUrl(p));

// Rows shaped like the real read: message/value/expected from the finding_defs
// join, plus the serialized item payload flattenChecks stamps.
const PER_PAGE = Math.ceil(FINDINGS / PAGES);
function rowsForPage(p: number): PageFindingRecord[] {
  const url = pageUrl(p);
  const out: PageFindingRecord[] = [];
  for (let i = 0; i < PER_PAGE; i++) {
    const r = i % RULES;
    out.push({
      siteKey: "web_bench",
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
      fingerprint: `fp-${p}-${i}`,
      firstSeenAt: 1_700_000_000_000,
      lastSeenCrawlId: "audit_bench",
      lastSeenAt: 1_700_000_000_000,
      provenance: "fresh",
      state: "open",
    });
  }
  return out;
}

const started = Date.now();
let overall: number | null = null;

if (mode === "materialized") {
  // What loadIngestedFindings returned: the whole audit in one array.
  const ingestedFindings: PageFindingRecord[] = [];
  for (let p = 0; p < PAGES; p++) ingestedFindings.push(...rowsForPage(p));
  const freshResults = reconstructCompleteResults({
    ruleResults,
    ingestedFindings,
    crawledUrls,
  });
  const union = buildScoringResultsFromMerged({
    freshResults,
    carriedFindings: [],
    carriedPageUrls: new Set(),
    ruleMetaIndex: new Map(Object.entries(ruleResults).map(([id, r]) => [id, r.meta])),
  });
  overall = calculateHealthScore({ results: union }).overall;
} else {
  // What the cursor yields: one page at a time, dropped after each fold.
  async function* findingPages(): AsyncGenerator<PageFindingRecord[]> {
    for (let p = 0; p < PAGES; p++) yield rowsForPage(p);
  }
  const tallies = await foldCompleteStoreTallies({
    ruleResults,
    findingPages: findingPages(),
    crawledUrls,
    carriedFindings: [],
    carriedPageUrls: new Set(),
    ruleMetaIndex: new Map(Object.entries(ruleResults).map(([id, r]) => [id, r.meta])),
  });
  overall = calculateHealthScoreFromTallies(tallies, new Map()).overall;
}

console.log(
  JSON.stringify({
    mode,
    pages: PAGES,
    findings: PER_PAGE * PAGES,
    rules: RULES,
    overall,
    elapsedMs: Date.now() - started,
    rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  }),
);
