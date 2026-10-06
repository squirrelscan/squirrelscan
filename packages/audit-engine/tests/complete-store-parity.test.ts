// Complete-store finalize parity harness (#1023 R-D3) — THE MERGE GATE.
//
// The chunked-publish path streams COMPLETE per-page findings into the store and
// finalize reconstructs `freshResults` from them (reconstructCompleteResults)
// instead of the #1167 100-per-check SAMPLED report. This harness proves:
//   (round-trip) flattenChecks → reconstruct is lossless on the scoring surface;
//   (a) sample==complete (≤100 pages/check): the complete-path union score is
//       BYTE-IDENTICAL to today's sample-path score;
//   (b) sample<complete (a rule failing on >100 pages): the score DIVERGES in a
//       documented direction — complete is LOWER (it scores every failing page,
//       not a 100-page sample, while the denominator grows to the true crawl);
//   (c) the complete path's scoring crawledUrls == resolutionSignal.crawledUrls.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import {
  capChecksForPublish,
  sampleChecksForPublish,
  DEFAULT_PUBLISH_SAMPLE,
} from "@squirrelscan/rules/fold";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";

import {
  aggregateUntouchedCarried,
  CARRIED_REPORT_SAMPLE_PER_RULE,
  isAggregatableCarriedRow,
  type FindingPageSource,
  type UntouchedCarriedPage,
  type UntouchedSamplePage,
} from "../src/complete-store-fold";
import { findingKey, flattenChecks } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type CloudSmartAuditsResult,
  type OpenFindingPage,
  type SmartAuditStore,
} from "../src/merge-promise";
import { reconstructCompleteResults } from "../src/reconstruct";
import {
  buildScoringResultsFromMerged,
  calculateHealthScore,
  calculateHealthScoreFromTallies,
} from "../src/scoring";
import { findingFingerprint } from "../src/fingerprint";
import { buildSkippedPassCounts, buildStreamFindings } from "../src/stream-findings";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  private key(f: { normalizedUrl: string; ruleId: string; checkName: string; locator: string }) {
    return findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator);
  }
  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) {
      // Mirror the store's LEAST(first_seen) conflict rule so a re-persist keeps
      // the earliest first-seen (matters for the pre-seed → merge flow).
      const k = this.key(f);
      const prior = this.findings.get(k);
      this.findings.set(k, {
        ...f,
        firstSeenAt: prior ? Math.min(prior.firstSeenAt, f.firstSeenAt) : f.firstSeenAt,
      });
    }
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved(
    siteKey: string,
    normalizedUrl: string,
    crawlId: string,
    lastStatus: number,
  ): Promise<void> {
    this.pages.set(normalizedUrl, {
      siteKey,
      normalizedUrl,
      lastStatus,
      state: "removed",
      lastSeenCrawlId: crawlId,
      lastSeenAt: Date.now(),
    });
    for (const [k, f] of this.findings) {
      if (f.normalizedUrl === normalizedUrl && f.state === "open") {
        this.findings.set(k, { ...f, state: "stale", lastSeenCrawlId: crawlId });
      }
    }
  }
  async markPagesRemoved(
    siteKey: string,
    pages: Array<{ normalizedUrl: string; lastStatus: number }>,
    crawlId: string,
  ): Promise<void> {
    for (const p of pages)
      await this.markPageRemoved(siteKey, p.normalizedUrl, crawlId, p.lastStatus);
  }
  async compactFindings(): Promise<number> {
    return 0;
  }
}

const pageMeta = {
  id: "meta-description",
  name: "Meta Description",
  description: "Pages should have a meta description",
  category: "content",
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
};

const url = (i: number) => `https://x.test/p/${i}`;

/** Native (pre-publish) per-page checks: `failCount` fail, the rest pass. */
function nativeChecks(total: number, failCount: number): CheckResult[] {
  const checks: CheckResult[] = [];
  for (let i = 0; i < total; i++) {
    checks.push(
      i < failCount
        ? {
            name: "has-meta-description",
            status: "fail",
            message: "Missing meta description",
            pageUrl: url(i),
          }
        : { name: "has-meta-description", status: "pass", message: "ok", pageUrl: url(i) },
    );
  }
  return checks;
}

/** Convert flat findings → store records (as the chunk ingest wrote them). */
function toIngested(
  checks: CheckResult[],
  siteKey: string,
  auditId: string,
): PageFindingRecord[] {
  const out: PageFindingRecord[] = [];
  // Group native per-page checks by page as flattenChecks expects (one call per
  // (page, rule)); here one rule, so group by pageUrl.
  const byPage = new Map<string, CheckResult[]>();
  for (const c of checks) {
    if (!c.pageUrl) continue;
    const arr = byPage.get(c.pageUrl);
    if (arr) arr.push(c);
    else byPage.set(c.pageUrl, [c]);
  }
  for (const [pageUrl, cs] of byPage) {
    for (const f of flattenChecks(pageUrl, pageMeta.id, cs)) {
      out.push({
        siteKey,
        normalizedUrl: f.normalizedUrl,
        ruleId: f.ruleId,
        checkName: f.checkName,
        locator: f.locator,
        status: f.status,
        severity: pageMeta.severity,
        message: f.message,
        value: f.value,
        expected: f.expected,
        payload: f.payload,
        fingerprint: findingFingerprint(f.status, f.message, f.value, f.expected),
        firstSeenAt: 1_700_000_000_000,
        lastSeenCrawlId: auditId,
        lastSeenAt: 1_700_000_000_000,
        provenance: "fresh",
        state: "open",
      });
    }
  }
  return out;
}

/** Today's producer pipeline: fold over-cap arrays, then sample pages[] to 100. */
function sampledReport(native: CheckResult[]) {
  const folded = capChecksForPublish(native, REPORT_LIMITS.maxChecksPerRule);
  const sampled = sampleChecksForPublish(folded, DEFAULT_PUBLISH_SAMPLE);
  return { [pageMeta.id]: { meta: pageMeta, checks: sampled } };
}

/**
 * (#1873) Page-at-a-time source, mirroring the API's keyset cursor: rows in
 * page_findings PK order (normalizedUrl, ruleId, checkName, locator), yielded one
 * whole page at a time. The page-boundary contract is what keeps the incremental
 * fold byte-identical to folding the concatenated array.
 */
async function* pageSource(findings: PageFindingRecord[]): FindingPageSource {
  const sorted = [...findings].sort((a, b) => {
    const k1 = findingKey(a.normalizedUrl, a.ruleId, a.checkName, a.locator);
    const k2 = findingKey(b.normalizedUrl, b.ruleId, b.checkName, b.locator);
    return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
  });
  const byPage = new Map<string, PageFindingRecord[]>();
  for (const f of sorted) {
    const rows = byPage.get(f.normalizedUrl);
    if (rows) rows.push(f);
    else byPage.set(f.normalizedUrl, [f]);
  }
  for (const rows of byPage.values()) yield rows;
}

/** completeStore input from a materialized ingest array (the store the API reads). */
function completeInput(
  ingested: PageFindingRecord[],
  crawled: string[],
  skippedPassCounts?: Record<string, Record<string, number>>,
) {
  return {
    findingPages: pageSource(ingested),
    // These fixtures run against an empty store, so nothing predates this audit.
    priorOpenFindings: [] as PageFindingRecord[],
    crawledUrls: crawled,
    ...(skippedPassCounts ? { skippedPassCounts } : {}),
  };
}

/**
 * The published score on the complete path (#1873): folded per-rule tallies, NOT
 * the union map — which now carries only the shell's bounded display sample.
 * `unionRuleResults` still supplies the robots/sitemap penalty rules verbatim.
 */
function completeHealthScore(result: CloudSmartAuditsResult) {
  return calculateHealthScoreFromTallies(result.scoringTallies!, result.unionRuleResults);
}

/**
 * The PRE-#1873 materialized complete path — reconstruct every page, build the
 * union, score it — kept as the reference the bounded fold is measured against.
 */
function materializedCompleteScore(
  ruleResults: Record<string, { meta: typeof pageMeta; checks: CheckResult[] }>,
  ingested: PageFindingRecord[],
  crawled: string[],
  skippedPassCounts?: Record<string, Record<string, number>>,
) {
  const crawledUrls = new Set(crawled);
  const freshResults = reconstructCompleteResults({
    ruleResults,
    ingestedFindings: ingested,
    crawledUrls,
    skippedPassCounts,
  });
  const ruleMetaIndex = new Map(
    Object.entries(ruleResults).map(([ruleId, r]) => [ruleId, r.meta]),
  );
  const union = buildScoringResultsFromMerged({
    freshResults,
    carriedFindings: [],
    carriedPageUrls: new Set<string>(),
    ruleMetaIndex,
  });
  return calculateHealthScore({ results: union });
}

async function runSample(siteKey: string, native: CheckResult[], crawled: string[]) {
  const store = new MemStore();
  return runCloudSmartAudits({
    store,
    siteKey,
    crawlId: "audit_1",
    ruleResults: sampledReport(native),
    pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
  });
}

async function runComplete(siteKey: string, native: CheckResult[], crawled: string[]) {
  const store = new MemStore();
  const ingested = toIngested(native, siteKey, "audit_1");
  // Passing-sibling counts from the COMPLETE (pre-sample) checks — empty for the
  // single-checkName fixtures below (a page is all-fail or all-pass), so those stay
  // byte-identical; only the multi-checkName fixture exercises it.
  const skippedPassCounts = buildSkippedPassCounts({ [pageMeta.id]: { checks: native } });
  return runCloudSmartAudits({
    store,
    siteKey,
    crawlId: "audit_1",
    // The shell still carries the (sampled) ruleResults — the source of rule META.
    ruleResults: sampledReport(native),
    pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
    completeStore: completeInput(ingested, crawled, skippedPassCounts),
  });
}

// ── round-trip ──────────────────────────────────────────────────────────────
describe("reconstruct round-trip (flattenChecks inverse)", () => {
  test("whole-check + item findings reconstruct the scoring surface", () => {
    const native: CheckResult[] = [
      { name: "c-whole", status: "fail", message: "no meta", pageUrl: url(0) },
      {
        name: "c-items",
        status: "fail",
        message: "bad items",
        pageUrl: url(1),
        items: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        details: { additional: 5 },
      },
    ];
    const findings = toIngested(native, "web", "audit_1");
    const crawled = new Set([url(0), url(1), url(2)]);
    const rebuilt = reconstructCompleteResults({
      ruleResults: { [pageMeta.id]: { meta: pageMeta, checks: [] } },
      ingestedFindings: findings,
      crawledUrls: crawled,
    }).get(pageMeta.id)!;

    // One check per (page, checkName); scoring reads status/pageUrl/items/details.additional.
    const byPage = new Map(rebuilt.checks.map((c) => [`${c.pageUrl}|${c.name}`, c]));
    const whole = byPage.get(`${url(0)}|c-whole`)!;
    expect(whole.status).toBe("fail");
    expect(whole.items).toBeUndefined();
    const items = byPage.get(`${url(1)}|c-items`)!;
    expect(items.status).toBe("fail");
    expect(items.items?.map((i) => i.id)).toEqual(["a", "b"]);
    expect(items.details?.additional).toBe(5);
    // syntheticPassCount = crawled(3) − failing-pages(2) = 1 clean page (url 2).
    expect(rebuilt.syntheticPassCount).toBe(1);
  });

  test("items[] reconstruct in EMISSION order, not locator sort order (>=11 numeric ids)", () => {
    // A check with 13 items whose ids are unpadded numeric suffixes (parse-0..12)
    // — the id scheme real rules use (json-ld-valid `parse-${index}`, eeat
    // `signal-${i}`). loadIngestedFindings returns rows ORDER BY locator, a plain
    // lexicographic string sort, so the store hands reconstruct these findings in
    // SCRAMBLED order ("parse-10" < "parse-2"). The reconstruction must restore the
    // rule's original emission order regardless.
    const items = Array.from({ length: 13 }, (_, i) => ({ id: `parse-${i}`, label: `L${i}` }));
    const native: CheckResult[] = [
      { name: "c-items", status: "fail", message: "bad items", pageUrl: url(0), items },
    ];
    const emitted = items.map((it) => it.id); // parse-0 … parse-12

    // Reproduce loadIngestedFindings' `ORDER BY … locator` (byte lexicographic).
    const loaded = [...toIngested(native, "web", "audit_1")].sort((a, b) =>
      a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0,
    );
    // Sanity: the load order really is scrambled vs emission (else the test can't
    // catch the regression it targets).
    expect(loaded.map((f) => f.locator)).not.toEqual(emitted);

    const rebuilt = reconstructCompleteResults({
      ruleResults: { [pageMeta.id]: { meta: pageMeta, checks: [] } },
      ingestedFindings: loaded,
      crawledUrls: new Set([url(0)]),
    }).get(pageMeta.id)!;

    const check = rebuilt.checks.find((c) => c.name === "c-items")!;
    expect(check.items?.map((it) => it.id)).toEqual(emitted);
  });

  test("re-flattening the reconstruction yields the SAME finding keys (merge-safe)", () => {
    const native = nativeChecks(40, 12);
    const findings = toIngested(native, "web", "audit_1");
    const rebuilt = reconstructCompleteResults({
      ruleResults: { [pageMeta.id]: { meta: pageMeta, checks: [] } },
      ingestedFindings: findings,
      crawledUrls: new Set(native.map((c) => c.pageUrl!)),
    }).get(pageMeta.id)!;
    const reflattened = rebuilt.checks.flatMap((c) => flattenChecks(c.pageUrl!, pageMeta.id, [c]));
    const origKeys = new Set(
      findings.map((f) => findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator)),
    );
    const newKeys = new Set(
      reflattened.map((f) => findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator)),
    );
    expect(newKeys).toEqual(origKeys);
  });
});

// ── multi-checkName rule: partial fail + passing sibling (faq.ts pattern, #1305) ──
// A page-scope rule that emits SEPARATE check names on one page, some fail/warn +
// some pass (schema/faq: faq-questions warn + faq-valid pass). page_findings stores
// only the warn; the page is excluded from fresh-clean syntheticPassCount, so the
// passing sibling would be lost — scoring the page 0.5/1 instead of the sampled
// 1.5/2. The container's buildSkippedPassCounts ships the sibling pass back.
describe("multi-checkName rule: passing sibling on a partial-fail page (#1305)", () => {
  const faqMeta = {
    id: "schema/faq",
    name: "FAQ",
    description: "FAQ structured data",
    category: "content",
    scope: "page" as const,
    severity: "warning" as const,
    weight: 10,
  };

  test("one page warn+pass under one rule → complete score == sampled score", async () => {
    const native: CheckResult[] = [
      { name: "faq-questions", status: "warn", message: "1 invalid question", pageUrl: url(0) },
      { name: "faq-valid", status: "pass", message: "2 valid questions", pageUrl: url(0) },
    ];
    const crawled = [url(0)];
    const ruleResults = { [faqMeta.id]: { meta: faqMeta, checks: native } };

    // Sample: scores every emitted check — warn(0.5) + pass(1) = 1.5/2.
    const sample = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_faq_s",
      crawlId: "audit_1",
      ruleResults,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
    });

    // Complete: only the warn was streamed (flattenChecks skips pass); the passing
    // sibling comes back via buildSkippedPassCounts → syntheticPassCount.
    const ingested = toIngested(native, "web_faq_c", "audit_1").map((r) => ({
      ...r,
      ruleId: faqMeta.id,
    }));
    const skippedPassCounts = buildSkippedPassCounts({ [faqMeta.id]: { checks: native } });
    const complete = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_faq_c",
      crawlId: "audit_1",
      ruleResults,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
      completeStore: completeInput(ingested, crawled, skippedPassCounts),
    });

    // The passing sibling is counted (1), not lost: the rule's tally is the warn
    // (0.5) plus one synthetic pass, exactly the sampled path's 1.5/2.
    expect(complete.scoringTallies!.get(faqMeta.id)!.tally.passed).toBe(1);
    // Byte-identical to the sampled path (both 1.5/2 = 75%). Fails pre-#1305 (0.5/1).
    expect(completeHealthScore(complete)).toEqual(
      calculateHealthScore({ results: sample.unionRuleResults }),
    );
  });

  test("an absurd skippedPassCounts count is CLAMPED to the crawl universe (no passRate inflation)", () => {
    // A rule failing on BOTH crawled pages (clean = 0), but a buggy/compromised
    // container ships 1e9 passing siblings in the finalize body. Unclamped, that
    // drives passRate → ~1.0 on a genuinely-failing rule (the #1179 integrity class
    // this PR fixes). The server clamps the per-rule sum to crawledUrls.size.
    const native: CheckResult[] = [
      { name: "faq-questions", status: "fail", message: "bad", pageUrl: url(0) },
      { name: "faq-questions", status: "fail", message: "bad", pageUrl: url(1) },
    ];
    const crawled = new Set([url(0), url(1)]);
    const ingested = toIngested(native, "web_faq_clamp", "audit_1").map((r) => ({
      ...r,
      ruleId: faqMeta.id,
    }));
    const rebuilt = reconstructCompleteResults({
      ruleResults: { [faqMeta.id]: { meta: faqMeta, checks: [] } },
      ingestedFindings: ingested,
      crawledUrls: crawled,
      skippedPassCounts: { [faqMeta.id]: { "faq-valid": 1_000_000_000 } },
    }).get(faqMeta.id)!;

    // clean = 0 (both pages dirty) → syntheticPassCount = min(1e9, crawled.size).
    expect(rebuilt.syntheticPassCount).toBe(crawled.size); // 2, NOT 1e9
    expect(rebuilt.syntheticPassCount).toBeLessThanOrEqual(crawled.size);
    // Sane score: 2 fails + 2 synthetic passes = 0.5, nowhere near the ~100 the
    // unclamped 1e9 would have produced.
    const overall = calculateHealthScore({
      results: new Map([[faqMeta.id, rebuilt]]),
    }).overall!;
    expect(overall).toBeLessThan(80);
  });
});

// ── (a) sample == complete → byte-identical ──────────────────────────────────
describe("(a) sample==complete: byte-identical published score", () => {
  for (const [total, fail] of [
    [100, 30],
    [100, 0],
    [100, 100],
    [50, 17],
  ] as const) {
    test(`${total} pages, ${fail} failing → identical health score`, async () => {
      const native = nativeChecks(total, fail);
      const crawled = native.map((c) => c.pageUrl!);
      const sample = await runSample("web_s", native, crawled);
      const complete = await runComplete("web_c", native, crawled);
      const sScore = calculateHealthScore({ results: sample.unionRuleResults });
      const cScore = completeHealthScore(complete);
      expect(cScore).toEqual(sScore); // full HealthScore, not just .overall
      // coverage matches too (denominator + known-page count).
      expect(complete.coverage.auditedPages).toBe(sample.coverage.auditedPages);
    });
  }
});

// ── (b) sample < complete → asserted divergence direction ────────────────────
describe("(b) sample<complete: complete scores LOWER (more failing pages counted)", () => {
  test("rule fails on 600 of 700 crawled → complete union score < sample", async () => {
    // 600 fail + 100 pass = 700 checks > maxChecksPerRule(500): the producer FOLDS
    // then SAMPLES the fail aggregate's pages[] to 100. The sample path then scores
    // ~100 fail + 100 pass (0.5); the complete path scores all 600 fails against
    // the true 700-page crawl (0.143).
    const native = nativeChecks(700, 600);
    const crawled = native.map((c) => c.pageUrl!);

    const sample = await runSample("web_s", native, crawled);
    const complete = await runComplete("web_c", native, crawled);
    const sOverall = calculateHealthScore({ results: sample.unionRuleResults }).overall!;
    const cOverall = completeHealthScore(complete).overall!;

    // Direction: complete counts every failing page → strictly lower score.
    expect(cOverall).toBeLessThan(sOverall);

    // The sample lost failing pages: its union has ≤100 fail checks. The complete
    // path counts all 600 in its TALLY — (#1873) not as 600 materialized checks.
    const sFails = sample.unionRuleResults
      .get(pageMeta.id)!
      .checks.filter((c) => c.status === "fail").length;
    expect(sFails).toBeLessThanOrEqual(DEFAULT_PUBLISH_SAMPLE.maxPagesPerCheck);
    const cTally = complete.scoringTallies!.get(pageMeta.id)!.tally;
    expect(cTally.failed).toBe(600);

    // The complete denominator is the true crawl, so its passRate = 100/700: the
    // 100 clean pages arrive as synthetic passes, never as pass CheckResults.
    expect(cTally.passed).toBe(100); // 700 crawled − 600 failing
  });
});

// ── skip-as-pass: MEASURED divergence (not a byte-identical gate) ─────────────
// A page-scope rule that SKIPS a subset of crawled pages (emits no evaluated
// check — e.g. perf/ttfb without timing data). The sample path scores it over
// ONLY its evaluated pages; the complete path's syntheticPassCount = crawled −
// failing counts skipped pages as clean passes, so a skip-heavy rule scores
// HIGHER on the complete path. This quantifies that inflation so the accepted
// crawled−failing approximation is evidence-based, not assumed.
describe("skip-as-pass divergence (measured, bounded, expected direction)", () => {
  const skipMeta = {
    id: "perf/ttfb",
    name: "TTFB",
    description: "Pages should respond quickly",
    // Category is irrelevant to the pass-denominator measurement; use a known-
    // valid code so getCategoryName/getCategoryGroup resolve.
    category: "content",
    scope: "page" as const,
    severity: "error" as const,
    weight: 10,
  };

  /** `fail` fail + `pass` pass evaluated pages, then `skip` crawled pages with NO
   * check for this rule (skipped). Returns native checks + the full crawl. */
  function skipFixture(fail: number, pass: number, skip: number) {
    const native: CheckResult[] = [];
    let i = 0;
    for (let k = 0; k < fail; k++, i++)
      native.push({ name: "ttfb-fast", status: "fail", message: "slow", pageUrl: url(i) });
    for (let k = 0; k < pass; k++, i++)
      native.push({ name: "ttfb-fast", status: "pass", message: "ok", pageUrl: url(i) });
    const crawled = Array.from({ length: fail + pass + skip }, (_, j) => url(j));
    return { native, crawled };
  }

  async function scores(fail: number, pass: number, skip: number) {
    const { native, crawled } = skipFixture(fail, pass, skip);
    const ruleResults = { [skipMeta.id]: { meta: skipMeta, checks: native } };
    // Sample: freshResults from the report's checks (evaluated pages only).
    const sample = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_skip_s",
      crawlId: "a1",
      ruleResults,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
    });
    // Complete: findings (fails only) + crawledUrls; skipped pages become synthetic passes.
    const ingested = toIngested(native, "web_skip_c", "a1").map((r) => ({ ...r, ruleId: skipMeta.id }));
    const complete = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_skip_c",
      crawlId: "a1",
      ruleResults,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
      completeStore: completeInput(ingested, crawled),
    });
    const s = calculateHealthScore({ results: sample.unionRuleResults });
    const c = completeHealthScore(complete);
    return {
      s,
      c,
      sampleRule: sample.unionRuleResults.get(skipMeta.id)!,
      completeTally: complete.scoringTallies!.get(skipMeta.id)!.tally,
    };
  }

  test("skip-heavy rule (20 fail, 100 pass, 80 skipped of 200) — complete inflates, bounded", async () => {
    const { s, c, sampleRule, completeTally } = await scores(20, 100, 80);
    // Per-rule pass-ratio: sample = 100/120 = 0.833; complete = 180/200 = 0.90.
    const sampleTotal = sampleRule.checks.length + (sampleRule.syntheticPassCount ?? 0);
    const completeTotal = completeTally.passed + completeTally.warnings + completeTally.failed;
    expect(sampleTotal).toBe(120); // evaluated only
    expect(completeTotal).toBe(200); // + 80 skipped counted as passes
    expect(completeTally.passed).toBe(180);

    // eslint-disable-next-line no-console
    console.log(
      `[skip-as-pass] 20f/100p/80skip: sample overall=${s.overall} complete overall=${c.overall} Δ=${c.overall! - s.overall!}`,
    );
    // Direction: complete inflates (skipped read as clean).
    expect(c.overall!).toBeGreaterThan(s.overall!);
    // Bounded: measured Δ=+4 for this undiluted single-rule 40%-skip pathological
    // case (a real 260-rule mix dilutes it further). ≤6 leaves curve/density
    // headroom while catching any regression to large inflation.
    expect(c.overall! - s.overall!).toBeLessThanOrEqual(6);
  });

  test("no skips ⇒ zero divergence (the approximation only bites on skipped pages)", async () => {
    const { s, c } = await scores(20, 100, 0);
    expect(c.overall).toBe(s.overall);
  });

  test("realistic light-skip (10 fail, 180 pass, 10 skipped of 200) — tiny divergence", async () => {
    const { s, c } = await scores(10, 180, 10);
    // eslint-disable-next-line no-console
    console.log(
      `[skip-as-pass] 10f/180p/10skip: sample overall=${s.overall} complete overall=${c.overall} Δ=${c.overall! - s.overall!}`,
    );
    expect(c.overall!).toBeGreaterThanOrEqual(s.overall!);
    expect(c.overall! - s.overall!).toBeLessThanOrEqual(3);
  });
});

// ── producer → consumer: buildStreamFindings round-trips through the store ────
describe("container producer (buildStreamFindings) → server reconstruct", () => {
  test("streamed findings reconstruct to the same score as the sample path (a)", async () => {
    const native = nativeChecks(80, 25);
    const crawled = native.map((c) => c.pageUrl!);
    // The container flattens the PRE-sample report to complete stream lines.
    const lines = buildStreamFindings({ [pageMeta.id]: { meta: pageMeta, checks: native } }, 1);
    // The server stamps siteKey + lastSeenCrawlId as it ingests each line.
    const ingested: PageFindingRecord[] = lines.map((l) => ({
      ...l,
      siteKey: "web_p",
      lastSeenCrawlId: "audit_1",
    }));
    const store = new MemStore();
    const complete = await runCloudSmartAudits({
      store,
      siteKey: "web_p",
      crawlId: "audit_1",
      ruleResults: sampledReport(native),
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
      completeStore: completeInput(ingested, crawled),
    });
    const sample = await runSample("web_ps", native, crawled);
    expect(completeHealthScore(complete)).toEqual(
      calculateHealthScore({ results: sample.unionRuleResults }),
    );
    // Producer dedupes by PK so the streamed count equals the store row count
    // (finalize's received>=expected gate). No dup keys here → 25 fail findings.
    expect(lines.length).toBe(25);
  });
});

// ── (c) denominator = resolutionSignal.crawledUrls exactly ───────────────────
describe("(c) complete crawledUrls == the unsampled crawled set", () => {
  test("auditedPages equals the full crawl even when findings cover fewer pages", async () => {
    // 600 failing pages, but 700 crawled (100 clean). The denominator must be 700,
    // not the 600 that produced findings.
    const native = nativeChecks(700, 600);
    const crawled = native.map((c) => c.pageUrl!);
    const complete = await runComplete("web_c", native, crawled);
    expect(complete.coverage.auditedPages).toBe(crawled.length); // == crawledUrls
    expect(complete.completeStore).toBe(true);
  });
});

// ── (d) THE #1873 GATE: bounded fold == materialized reconstruction ──────────
// #1023 R-D3 scored the complete store by materializing it (reconstruct every
// page → union map → calculateHealthScore), which OOM'd the 128 MB API isolate at
// 43k findings (#1873). The bounded fold replaced it. These assert the two produce
// the SAME HealthScore — not merely the same overall number — on every fixture,
// so the memory fix cannot silently move a customer's score.
describe("(d) bounded fold == the materialized reconstruction (#1873)", () => {
  for (const [total, fail] of [
    [100, 30],
    [100, 0],
    [100, 100],
    [50, 17],
    [700, 600],
  ] as const) {
    test(`${total} pages, ${fail} failing → identical to the materialized path`, async () => {
      const native = nativeChecks(total, fail);
      const crawled = native.map((c) => c.pageUrl!);
      const ingested = toIngested(native, "web_d", "audit_1");
      const shell = sampledReport(native);
      const bounded = await runCloudSmartAudits({
        store: new MemStore(),
        siteKey: "web_d",
        crawlId: "audit_1",
        ruleResults: shell,
        pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
        completeStore: completeInput(ingested, crawled),
      });
      expect(completeHealthScore(bounded)).toEqual(
        materializedCompleteScore(shell, ingested, crawled),
      );
    });
  }

  test("multi-item checks (per-key unit cap + additional) survive page-at-a-time folding", async () => {
    // The fold's byte-identity rests on (checkName, pageUrl) buckets never being
    // split across calls: items and `details.additional` feed a per-key SUM and
    // MAX that are local to one addChecksToTally call. Items per page + a
    // remainder is exactly the shape that would diverge if a page were split.
    const native: CheckResult[] = [];
    for (let i = 0; i < 40; i++) {
      native.push({
        name: "img-alt",
        status: i % 3 === 0 ? "warn" : "fail",
        message: "missing alt",
        pageUrl: url(i),
        items: Array.from({ length: 1 + (i % 7) }, (_, k) => ({ id: `img-${k}`, label: `#${k}` })),
        details: { additional: i % 5 },
      });
    }
    const crawled = Array.from({ length: 60 }, (_, i) => url(i));
    const ingested = toIngested(native, "web_units", "audit_1");
    const shell = sampledReport(native);
    const bounded = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_units",
      crawlId: "audit_1",
      ruleResults: shell,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
      completeStore: completeInput(ingested, crawled),
    });
    expect(completeHealthScore(bounded)).toEqual(
      materializedCompleteScore(shell, ingested, crawled),
    );
  });

  test("skippedPassCounts (#1305) and its security clamp fold identically", async () => {
    const native: CheckResult[] = [
      { name: "faq-questions", status: "warn", message: "1 invalid", pageUrl: url(0) },
      { name: "faq-questions", status: "fail", message: "broken", pageUrl: url(1) },
    ];
    const crawled = [url(0), url(1), url(2)];
    const ingested = toIngested(native, "web_skip", "audit_1");
    const shell = sampledReport(native);
    for (const counts of [
      { [pageMeta.id]: { "faq-valid": 2 } },
      { [pageMeta.id]: { "faq-valid": 1_000_000_000 } }, // clamped to crawled.size
    ]) {
      const bounded = await runCloudSmartAudits({
        store: new MemStore(),
        siteKey: "web_skip",
        crawlId: "audit_1",
        ruleResults: shell,
        pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
        completeStore: completeInput(ingested, crawled, counts),
      });
      expect(completeHealthScore(bounded)).toEqual(
        materializedCompleteScore(shell, ingested, crawled, counts),
      );
    }
  });

  test("a page that 404'd this run leaves the score, exactly as freshForUnion drops it", async () => {
    // A removed page can still carry ingested findings — the crawl rendered it
    // before the 404 was known — and the materialized path filtered those checks
    // out of the union before scoring. Folding them instead would count a deleted
    // page against the site.
    const native = nativeChecks(10, 3);
    const crawled = native.map((c) => c.pageUrl!);
    const removed = url(0); // a FAILING page, so dropping it actually moves the score
    const ingested = toIngested(native, "web_gone", "audit_1");
    const shell = sampledReport(native);

    const bounded = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_gone",
      crawlId: "audit_1",
      ruleResults: shell,
      pageStatuses: crawled.map((u) => ({ url: u, status: u === removed ? 404 : 200 })),
      completeStore: completeInput(ingested, crawled),
    });

    // Reference: the materialized path — crawledUrls loses the removed page, then
    // freshForUnion drops any check still sitting on it.
    const crawledUrls = new Set(crawled);
    crawledUrls.delete(removed);
    const freshResults = reconstructCompleteResults({
      ruleResults: shell,
      ingestedFindings: ingested,
      crawledUrls,
    });
    const freshForUnion = new Map(
      Array.from(freshResults, ([ruleId, r]) => [
        ruleId,
        {
          meta: r.meta,
          checks: r.checks.filter((c) => c.pageUrl !== removed),
          ...(r.syntheticPassCount !== undefined
            ? { syntheticPassCount: r.syntheticPassCount }
            : {}),
        },
      ]),
    );
    const union = buildScoringResultsFromMerged({
      freshResults: freshForUnion,
      carriedFindings: [],
      carriedPageUrls: new Set<string>(),
      ruleMetaIndex: new Map([[pageMeta.id, pageMeta]]),
    });
    expect(completeHealthScore(bounded)).toEqual(calculateHealthScore({ results: union }));

    // 3 pages failed, one of them is gone: 2 fails scored over the 9 live pages.
    const tally = bounded.scoringTallies!.get(pageMeta.id)!.tally;
    expect(tally.failed).toBe(2);
    expect(tally.passed).toBe(7);
  });

  test("carried findings on un-crawled pages fold identically to the union replay", async () => {
    // 10 crawled pages (2 failing) + 5 still-active pages this run did not crawl,
    // 2 of which carry an open finding. Exercises every carried term at once:
    // the replayed carried checks, and the 3 clean carried pages that must keep
    // counting in the pass denominator (#918).
    const native = nativeChecks(10, 2);
    const crawled = native.map((c) => c.pageUrl!);
    const ingested = toIngested(native, "web_carry", "audit_1");
    const shell = sampledReport(native);

    const store = new MemStore();
    const carriedPages = Array.from({ length: 5 }, (_, i) => `https://x.test/old/${i}`);
    const seeded: PageFindingRecord[] = carriedPages.slice(0, 2).map((u) => ({
      siteKey: "web_carry",
      normalizedUrl: u,
      ruleId: pageMeta.id,
      checkName: "has-meta-description",
      locator: "",
      status: "fail",
      severity: pageMeta.severity,
      message: "Missing meta description",
      value: null,
      expected: null,
      payload: null,
      fingerprint: findingFingerprint("fail", "Missing meta description", null, null),
      firstSeenAt: 1_600_000_000_000,
      lastSeenCrawlId: "audit_0",
      lastSeenAt: 1_600_000_000_000,
      provenance: "fresh",
      state: "open",
    }));
    await store.upsertFindings(seeded);
    await store.upsertSitePages(
      carriedPages.map((u) => ({
        siteKey: "web_carry",
        normalizedUrl: u,
        lastStatus: 200,
        state: "active" as const,
        lastSeenCrawlId: "audit_0",
        lastSeenAt: 1_600_000_000_000,
      })),
    );

    const bounded = await runCloudSmartAudits({
      store,
      siteKey: "web_carry",
      crawlId: "audit_1",
      ruleResults: shell,
      pageStatuses: crawled.map((u) => ({ url: u, status: 200 })),
      completeStore: {
        findingPages: pageSource(ingested),
        // Mirrors the API: prior OPEN rows EXCLUDING this audit's own ingest.
        priorOpenFindings: (await store.getFindings("web_carry", ["open"])).filter(
          (f) => f.lastSeenCrawlId !== "audit_1",
        ),
        crawledUrls: crawled,
      },
    });

    // Reference: the materialized union with the same carried inputs.
    const freshResults = reconstructCompleteResults({
      ruleResults: shell,
      ingestedFindings: ingested,
      crawledUrls: new Set(crawled),
    });
    const union = buildScoringResultsFromMerged({
      freshResults,
      carriedFindings: seeded.map((f) => ({
        normalizedUrl: f.normalizedUrl,
        ruleId: f.ruleId,
        checkName: f.checkName,
        status: f.status,
        message: f.message,
        value: f.value,
        expected: f.expected,
        payload: f.payload,
        neverRendered: false,
      })),
      carriedPageUrls: new Set(carriedPages),
      ruleMetaIndex: new Map([[pageMeta.id, pageMeta]]),
    });
    expect(completeHealthScore(bounded)).toEqual(calculateHealthScore({ results: union }));

    // And the carried terms really are there: 2 fresh + 2 carried fails, 8 fresh
    // clean + 3 clean carried pages.
    const tally = bounded.scoringTallies!.get(pageMeta.id)!.tally;
    expect(tally.failed).toBe(4);
    expect(tally.passed).toBe(11);
    expect(bounded.coverage.carriedFindings).toBe(2);
  });
});

// ── (e) THE pub#497 GATE: untouched carried pages as an aggregate ────────────
// The cloud's complete-store merge used to read and fold every open finding the
// site had, one row at a time, so a publish cost what the site's whole history
// cost. Untouched pages (not crawled, not removed, no fresh row) now reach the
// merge as the store's aggregate plus a bounded report sample, and only touched
// pages stream. These pin that the split is the SAME audit as the full row fold:
// tallies, score, coverage, union rule results and the rows left in the store,
// compared as serialized bytes so map ORDER counts too.
describe("(e) untouched carried pages as an aggregate == the full row fold (pub#497)", () => {
  const SITE = "web_497";
  const AUDIT = "audit_9";
  const PRIOR = "audit_8";
  const OLDER = "audit_7";
  const T_PRIOR = 1_650_000_000_000;
  const T_NOW = 1_700_000_000_000;

  const ruleA = { ...pageMeta, id: "content/rule-a", name: "Rule A" };
  // Advisory: its warns are recommendations, out of the tally entirely.
  const ruleB = {
    ...pageMeta,
    id: "content/rule-b",
    name: "Rule B",
    severity: "info" as const,
  };
  // Holds the payloads whose `items` is truthy but not iterable (and not an
  // object, which the aggregate cannot add exactly). Kept under the report's
  // carried budget: folding such a check throws in `foldGroup`, on the full row
  // fold as much as on the split, so a folded rule cannot hold one.
  const ruleC = { ...pageMeta, id: "content/rule-c", name: "Rule C" };
  // First seen on a touched page that sorts AFTER the backlog, so its tally slot
  // comes after rule C's, which only untouched pages hold.
  const ruleD = { ...pageMeta, id: "content/rule-d", name: "Rule D" };
  const ruleSite = {
    ...pageMeta,
    id: "crawl/site-rule",
    name: "Site rule",
    scope: "site" as const,
  };
  const shell = {
    [ruleA.id]: { meta: ruleA, checks: [] as CheckResult[] },
    [ruleB.id]: { meta: ruleB, checks: [] as CheckResult[] },
    [ruleC.id]: { meta: ruleC, checks: [] as CheckResult[] },
    [ruleD.id]: { meta: ruleD, checks: [] as CheckResult[] },
    [ruleSite.id]: {
      meta: ruleSite,
      checks: [{ name: "site-check", status: "warn", message: "site-wide" }] as CheckResult[],
    },
  };

  const pad = (i: number) => String(i).padStart(3, "0");
  const crawledPage = (i: number) => `https://x.test/a/${pad(i)}`;
  const backlogPage = (i: number) => `https://x.test/b/${pad(i)}`;

  function row(
    normalizedUrl: string,
    ruleId: string,
    checkName: string,
    locator: string,
    auditId: string,
    overrides: Partial<PageFindingRecord> = {},
  ): PageFindingRecord {
    const status = overrides.status ?? "fail";
    const message = overrides.message ?? `${checkName}${locator ? `: ${locator}` : ""}`;
    const t = auditId === AUDIT ? T_NOW : auditId === OLDER ? T_PRIOR - 50_000 : T_PRIOR;
    return {
      siteKey: SITE,
      normalizedUrl,
      ruleId,
      checkName,
      locator,
      status,
      severity: "warning",
      message,
      value: null,
      expected: null,
      payload: locator ? JSON.stringify({ items: [{ id: locator, label: locator }], i: 0 }) : null,
      fingerprint: findingFingerprint(status, message, null, null),
      firstSeenAt: t,
      lastSeenCrawlId: auditId,
      lastSeenAt: t,
      provenance: "fresh",
      state: "open",
      ...overrides,
    };
  }

  /** Payloads a store can hold, malformed ones included: the JS reads each its own way. */
  const ODD_PAYLOADS: Array<string | null> = [
    '{"items":[{"id":"x"}],"details":{"additional":7}}',
    '{"items":[{"id":"x"},{"id":"y"}],"details":{"additional":30},"m":"page text","v":"3"}',
    '{"details":{"occurrences":4,"pagesTruncated":90,"foldKey":"k1"}}',
    '{"details":{"occurrences":0.5}}',
    '{"details":{"occurrences":"9","pagesTruncated":"40","additional":"5"}}',
    '{"details":{"additional":-3,"occurrences":-1,"pagesTruncated":-2}}',
    '{"details":{"additional":2.9,"pagesTruncated":12.7}}',
    '{"items":"abc"}',
    '{"items":[]}',
    '{"items":null,"details":null}',
    '{"details":"not-an-object"}',
    '{"details":[1,2,3]}',
    "[1,2,3]",
    "42",
    '"a string"',
    "null",
    '{"items":[{"id":"x"}],"details":{"addi', // truncated by a store clamp
    "",
    null,
  ];
  /** `items` truthy and not iterable: counted as one unit. */
  const NON_ITERABLE_ITEMS = ['{"items":5}', '{"items":true}'];

  interface Fixture {
    rows: PageFindingRecord[];
    pages: SitePageRecord[];
    crawled: string[];
    statuses: Array<{ url: string; status: number }>;
  }

  function sitePage(normalizedUrl: string, state: "active" | "removed" = "active"): SitePageRecord {
    return {
      siteKey: SITE,
      normalizedUrl,
      lastStatus: state === "active" ? 200 : 404,
      state,
      lastSeenCrawlId: PRIOR,
      lastSeenAt: T_PRIOR,
    };
  }

  /**
   * Every shape at once. The backlog is past the per-rule report sample for rule A,
   * holds a class first seen after that budget is spent, an advisory rule, rows of
   * a site rule and of a rule absent from the shell, never-rendered pages, pages an
   * older audit saw removed, and every payload shape above. A touched page that is
   * NOT crawled (it holds a fresh row) sits in the middle of the backlog, so its
   * carried checks spend sample budget between untouched pages.
   */
  function everyShape(): Fixture {
    const rows: PageFindingRecord[] = [];
    const pages: SitePageRecord[] = [];
    const late = "https://x.test/zz/late";
    const crawled = [...Array.from({ length: 8 }, (_, i) => crawledPage(i)), late];
    for (const u of crawled) pages.push(sitePage(u));
    rows.push(row(late, ruleD.id, "check-d", "", AUDIT));

    // This run's ingest on crawled pages: whole-check and multi-item rows, one
    // bucket over ISSUE_PENALTY_ITEM_CAP.
    rows.push(row(crawled[0]!, ruleA.id, "check-1", "", AUDIT));
    for (let k = 0; k < 24; k++) {
      rows.push(
        row(crawled[1]!, ruleA.id, "check-1", `item-${pad(k)}`, AUDIT, {
          payload: JSON.stringify({ items: [{ id: `item-${pad(k)}` }], details: { additional: 4 }, i: k }),
        }),
      );
    }
    rows.push(row(crawled[2]!, ruleB.id, "advice", "", AUDIT, { status: "warn" }));
    // Reappearing: resolved once, back this run, keeping its old first-seen.
    rows.push(row(crawled[3]!, ruleA.id, "check-1", "", AUDIT, { firstSeenAt: T_PRIOR - 1_000 }));
    // Priors the run re-crawled and did not re-observe: resolve.
    rows.push(row(crawled[4]!, ruleA.id, "check-1", "", PRIOR));
    rows.push(row(crawled[5]!, ruleB.id, "advice", "", PRIOR, { status: "warn" }));

    // Removed this run: its prior stales, and an ingested row on it leaves the score.
    const removed = "https://x.test/a/gone";
    pages.push(sitePage(removed));
    rows.push(row(removed, ruleA.id, "check-1", "", PRIOR));
    rows.push(row(removed, ruleA.id, "check-2", "", AUDIT));

    // The backlog: 60 untouched pages.
    for (let i = 0; i < 60; i++) {
      const u = backlogPage(i);
      // Every 7th page was never rendered (no site_pages row); every 11th was
      // seen removed by an older audit (rendered, not active).
      if (i % 7 !== 3) pages.push(sitePage(u, i % 11 === 5 ? "removed" : "active"));
      const provenance = i % 2 === 0 ? "carried" : "fresh"; // steady and first carries
      const auditId = i % 3 === 0 ? OLDER : PRIOR;
      rows.push(row(u, ruleA.id, "check-1", "", auditId, { provenance }));
      if (i % 4 === 0) {
        // Multi-item rows sharing one bucket, summing past the item cap.
        for (let k = 0; k < 3; k++) {
          rows.push(
            row(u, ruleA.id, "check-3", `it-${k}`, auditId, {
              provenance,
              payload: JSON.stringify({
                items: [{ id: `it-${k}` }],
                details: { additional: 9 + k },
                i: k,
                m: "3 things wrong",
                v: "3",
              }),
            }),
          );
        }
      }
      rows.push(
        row(u, ruleA.id, "check-odd", "", auditId, {
          provenance,
          status: i % 5 === 0 ? "warn" : "fail",
          payload: ODD_PAYLOADS[i % ODD_PAYLOADS.length]!,
        }),
      );
      if (i % 3 === 1) {
        rows.push(row(u, ruleB.id, "advice", "", auditId, { status: i % 2 ? "warn" : "fail" }));
      }
      if (i % 10 === 2) rows.push(row(u, ruleSite.id, "site-check", "", auditId));
      if (i % 12 === 6) {
        rows.push(
          row(u, ruleC.id, "odd-items", "", auditId, {
            payload: NON_ITERABLE_ITEMS[(i / 12) % NON_ITERABLE_ITEMS.length | 0]!,
          }),
        );
      }
      if (i % 10 === 4) rows.push(row(u, "content/not-in-shell", "ghost", "", auditId));
    }
    // The class's newest sighting is on a row the report sample drops.
    const newest = findingKey(backlogPage(57), ruleA.id, "check-1", "");
    rows.forEach((r, i) => {
      if (findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator) === newest) {
        rows[i] = { ...r, lastSeenAt: T_PRIOR + 1_234 };
      }
    });
    // More distinct classes than the per-rule budget, early in the order.
    for (let k = 0; k < 30; k++) {
      rows.push(row(backlogPage(2), ruleA.id, `many-${pad(k)}`, "", PRIOR));
    }
    // A class first seen after rule A's sample budget is long spent.
    rows.push(row(backlogPage(58), ruleA.id, "zz-late-class", "", PRIOR));
    rows.push(row(backlogPage(59), ruleA.id, "zz-late-class", "", PRIOR));
    // A touched page that is NOT crawled: a fresh row with priors beside it, in
    // the middle of the backlog's order.
    const overlap = `${backlogPage(30)}-overlap`;
    pages.push(sitePage(overlap));
    rows.push(row(overlap, ruleA.id, "check-1", "item-new", AUDIT));
    rows.push(row(overlap, ruleA.id, "check-1", "item-old", PRIOR));
    rows.push(row(overlap, ruleA.id, "check-odd", "", PRIOR));

    return {
      rows,
      pages,
      crawled,
      statuses: [
        ...crawled.map((url) => ({ url, status: 200 })),
        { url: removed, status: 404 },
      ],
    };
  }

  function seed(fixture: Fixture): MemStore {
    const store = new MemStore();
    for (const r of fixture.rows) {
      store.findings.set(findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator), { ...r });
    }
    for (const p of fixture.pages) store.pages.set(p.normalizedUrl, { ...p });
    return store;
  }

  /** The store's open findings, page by page in cursor (primary-key) order. */
  function openPagesInOrder(store: MemStore): Array<[string, PageFindingRecord[]]> {
    const byPage = new Map<string, PageFindingRecord[]>();
    const sorted = [...store.findings.values()]
      .filter((f) => f.state === "open")
      .sort((a, b) => {
        const ka = findingKey(a.normalizedUrl, a.ruleId, a.checkName, a.locator);
        const kb = findingKey(b.normalizedUrl, b.ruleId, b.checkName, b.locator);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    for (const f of sorted) {
      const list = byPage.get(f.normalizedUrl);
      if (list) list.push(f);
      else byPage.set(f.normalizedUrl, [f]);
    }
    return [...byPage];
  }

  function openPage(normalizedUrl: string, rows: PageFindingRecord[]): OpenFindingPage {
    return {
      normalizedUrl,
      fresh: rows.filter((f) => f.lastSeenCrawlId === AUDIT),
      prior: rows.filter((f) => f.lastSeenCrawlId !== AUDIT),
    };
  }

  /** Today: every open page streams, row by row. */
  async function runRowFold(fixture: Fixture) {
    const store = seed(fixture);
    const pages = openPagesInOrder(store);
    async function* openPages() {
      for (const [u, rows] of pages) yield openPage(u, rows);
    }
    const result = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: AUDIT,
      ruleResults: shell,
      pageStatuses: fixture.statuses,
      now: T_NOW + 5,
      completeStore: { openPages: openPages(), crawledUrls: fixture.crawled },
    });
    return { result, store };
  }

  /**
   * The split, built the way a store must build it: untouched pages through the
   * reference aggregate, touched ones streamed, the two merged in cursor order,
   * and the untouched rows' carry applied by the store itself. `streamAnyway`
   * pages are untouched but streamed in full, which a store may always do.
   */
  /**
   * `exact`: the reference's sample. `all`: every untouched row. `some`: the
   * reference's sample plus every other remaining row, a superset in between.
   */
  type SampleMode = "exact" | "all" | "some";

  async function runSplit(
    fixture: Fixture,
    streamAnyway: Set<string> = new Set(),
    sampleMode: SampleMode = "exact",
  ) {
    const store = seed(fixture);
    let sampleRows = 0;
    let streamedRows = 0;
    const result = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: AUDIT,
      ruleResults: shell,
      pageStatuses: fixture.statuses,
      now: T_NOW + 5,
      completeStore: {
        crawledUrls: fixture.crawled,
        untouchedCarried: async (scope) => {
          const pages = openPagesInOrder(store);
          // One carried row the aggregate cannot add exactly, anywhere on the
          // site, and every page streams: an empty aggregate is the full fold.
          const exact = pages.every(
            ([u, rows]) =>
              scope.crawledUrls.has(u) ||
              scope.removedUrls.has(u) ||
              rows.every((r) => r.lastSeenCrawlId === AUDIT || isAggregatableCarriedRow(r)),
          );
          const isTouched = (u: string, rows: PageFindingRecord[]) =>
            !exact ||
            scope.crawledUrls.has(u) ||
            scope.removedUrls.has(u) ||
            rows.some((r) => r.lastSeenCrawlId === AUDIT) ||
            streamAnyway.has(u);
          const untouched: UntouchedCarriedPage[] = [];
          for (const [u, rows] of pages) {
            if (isTouched(u, rows)) continue;
            const page = store.pages.get(u);
            untouched.push({
              normalizedUrl: u,
              rows,
              rendered: !!page,
              active: page?.state === "active",
            });
          }
          const { aggregate, sample } = aggregateUntouchedCarried(untouched);
          const sampled = new Set(
            sample.flatMap((p) =>
              p.sample.map((r) => findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator)),
            ),
          );
          let extra = 0;
          const sampleByUrl = new Map<string, UntouchedSamplePage>();
          for (const p of untouched) {
            const rows = p.rows.filter((r) => {
              if (sampled.has(findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator))) return true;
              if (sampleMode === "all") return true;
              return sampleMode === "some" && extra++ % 2 === 0;
            });
            if (rows.length > 0) {
              sampleByUrl.set(p.normalizedUrl, { normalizedUrl: p.normalizedUrl, untouched: true, sample: rows });
            }
          }
          // The store's own carry of the rows the merge will never see.
          for (const p of untouched) {
            for (const r of p.rows) {
              const k = findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator);
              store.findings.set(k, { ...store.findings.get(k)!, provenance: "carried" });
            }
          }
          async function* merged() {
            for (const [u, rows] of pages) {
              if (isTouched(u, rows)) {
                streamedRows += rows.length;
                yield openPage(u, rows);
                continue;
              }
              const s = sampleByUrl.get(u);
              if (s) {
                sampleRows += s.sample.length;
                yield s;
              }
            }
          }
          return { pages: merged(), aggregate };
        },
      },
    });
    return { result, store, sampleRows, streamedRows };
  }

  /** Every surface a caller reads, serialized: map order and key order count. */
  function bytes(result: CloudSmartAuditsResult) {
    return {
      tallies: JSON.stringify([...result.scoringTallies!]),
      score: JSON.stringify(
        calculateHealthScoreFromTallies(result.scoringTallies!, result.unionRuleResults),
      ),
      coverage: JSON.stringify(result.coverage),
      union: JSON.stringify([...result.unionRuleResults]),
      persistedFindings: result.persistedFindings,
      removedPages: result.removedPages,
      carriedLastSeen: result.carriedLastSeen.size,
    };
  }

  function storeBytes(store: MemStore) {
    const rows = [...store.findings.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // This MemStore stamps a removed page with the wall clock, so that one field
    // differs between any two runs.
    const pages = [...store.pages.entries()]
      .map(([k, p]) => [k, p.state === "removed" && p.lastSeenCrawlId === AUDIT ? { ...p, lastSeenAt: 0 } : p])
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
    return JSON.stringify({ rows, pages });
  }

  test("tallies, score, coverage, union rule results and the store are byte-identical", async () => {
    const fixture = everyShape();
    const full = await runRowFold(fixture);
    const split = await runSplit(fixture);

    expect(bytes(split.result)).toEqual(bytes(full.result));
    expect(storeBytes(split.store)).toEqual(storeBytes(full.store));

    // The fixture really exercises what it claims: rule A is over the report's
    // carried budget and folds to aggregates, the late class survives, the
    // advisory rule has carried warns, and some carried findings are unrendered.
    const a = full.result.unionRuleResults.get(ruleA.id)!.checks;
    expect(a.some((c) => c.details?.aggregated === true)).toBe(true);
    expect(a.some((c) => c.name === "zz-late-class")).toBe(true);
    expect(full.result.coverage.unrenderedFindings).toBeGreaterThan(0);
    expect(full.result.coverage.carriedFindings).toBeGreaterThan(CARRIED_REPORT_SAMPLE_PER_RULE);
    expect(full.result.scoringTallies!.get(ruleB.id)!.tally.failed).toBeGreaterThan(0);
    // A dropped row's newer sighting reaches its class's aggregate.
    expect(
      a.find((c) => c.name === "check-1" && c.provenance === "carried")!.lastSeenAt,
    ).toBe(T_PRIOR + 1_234);
    // Rule C, held only by untouched pages, takes its tally slot before rule D,
    // whose first page is a touched one later in the order.
    const order = [...full.result.scoringTallies!.keys()];
    expect(order.indexOf(ruleC.id)).toBeLessThan(order.indexOf(ruleD.id));
  });

  test("only touched pages stream; the untouched ones send a bounded sample", async () => {
    const fixture = everyShape();
    const full = await runRowFold(fixture);
    const split = await runSplit(fixture);
    const carried = full.result.coverage.carriedFindings + (full.result.coverage.unrenderedFindings ?? 0);
    // Rows of the touched pages only: 30 on crawled pages, 2 on the removed one,
    // 3 on the uncrawled one holding a fresh row.
    expect(split.streamedRows).toBe(30 + 2 + 3);
    // Per rule: the first CARRIED_REPORT_SAMPLE_PER_RULE rows plus each later
    // class's first row, across 5 rules in the store.
    expect(split.sampleRows).toBeLessThan(5 * CARRIED_REPORT_SAMPLE_PER_RULE + 10);
    expect(split.sampleRows).toBeLessThan(carried);
  });

  test("an untouched page streamed in full instead is still the same audit", async () => {
    // A store streams a page whose rows its aggregate cannot read exactly. Pick
    // pages early in the order, so their carried checks take sample budget.
    const fixture = everyShape();
    const full = await runRowFold(fixture);
    const split = await runSplit(fixture, new Set([backlogPage(0), backlogPage(7), backlogPage(19)]));
    expect(bytes(split.result)).toEqual(bytes(full.result));
    expect(storeBytes(split.store)).toEqual(storeBytes(full.store));
  });

  test("a sample holding more than it must is still the same audit", async () => {
    // Every untouched row as the sample: retention only moves on a retained
    // check, so the extra rows are dropped exactly where the full fold drops them.
    const fixture = everyShape();
    const full = await runRowFold(fixture);
    for (const mode of ["all", "some"] as const) {
      const split = await runSplit(fixture, new Set(), mode);
      expect(bytes(split.result)).toEqual(bytes(full.result));
    }
  });

  test("a carried row the aggregate cannot add exactly means no aggregate at all", async () => {
    // Two malformed shapes reassociate: an `items` object counted by a fractional
    // `length`, and an occurrence weight past the safe range. Adding the untouched
    // subtotal at the end moves the float result even when the odd row's own page
    // streams, so one such row anywhere stops the split.
    const fixture = everyShape();
    // The middle fractional page streams, so its term lands between the others.
    [1.1, 1.2, 1.3].forEach((length, k) => {
      fixture.rows.push(
        row(backlogPage(10 + 20 * k), ruleC.id, "odd-items", "x", PRIOR, {
          payload: JSON.stringify({ items: { length } }),
        }),
      );
    });
    fixture.rows.push(
      row(backlogPage(11), ruleA.id, "check-1", "x", PRIOR, {
        payload: `{"details":{"occurrences":${Number.MAX_SAFE_INTEGER + 1}}}`,
      }),
    );
    const streamed = new Set([backlogPage(30)]);
    const oddRow = fixture.rows.at(-1)!;
    expect(isAggregatableCarriedRow(oddRow)).toBe(false);
    expect(() =>
      aggregateUntouchedCarried([
        { normalizedUrl: oddRow.normalizedUrl, rows: [oddRow], rendered: true, active: true },
      ]),
    ).toThrow(/exact domain/);

    // The store streams everything instead, and that is the full fold.
    const full = await runRowFold(fixture);
    const split = await runSplit(fixture, streamed);
    expect(split.sampleRows).toBe(0);
    expect(bytes(split.result)).toEqual(bytes(full.result));
    expect(storeBytes(split.store)).toEqual(storeBytes(full.store));

    // A store that aggregates anyway is refused, not published off by an ulp.
    const store = seed(fixture);
    const pages = openPagesInOrder(store);
    const u = backlogPage(1);
    const untouchedRows = pages.find(([url]) => url === u)![1];
    await expect(
      runCloudSmartAudits({
        store,
        siteKey: SITE,
        crawlId: AUDIT,
        ruleResults: shell,
        pageStatuses: fixture.statuses,
        now: T_NOW + 5,
        completeStore: {
          crawledUrls: fixture.crawled,
          untouchedCarried: async () => {
            const { aggregate, sample } = aggregateUntouchedCarried([
              { normalizedUrl: u, rows: untouchedRows, rendered: true, active: true },
            ]);
            async function* merged() {
              for (const [url, rows] of pages) {
                if (url === u) yield* sample;
                else yield openPage(url, rows);
              }
            }
            return { pages: merged(), aggregate };
          },
        },
      }),
    ).rejects.toThrow(/exact domain/);
  });

  test("under the report cap the split is byte-identical too", async () => {
    const fixture = everyShape();
    // Keep the backlog small: no rule over the budget, nothing folded.
    fixture.rows = fixture.rows.filter(
      (r) => !r.normalizedUrl.startsWith("https://x.test/b/") || r.normalizedUrl < backlogPage(6),
    );
    const full = await runRowFold(fixture);
    const split = await runSplit(fixture);
    expect(bytes(split.result)).toEqual(bytes(full.result));
    expect(storeBytes(split.store)).toEqual(storeBytes(full.store));
  });

  test("a sample page the run crawled is refused, not scored as carried", async () => {
    const fixture = everyShape();
    const store = seed(fixture);
    await expect(
      runCloudSmartAudits({
        store,
        siteKey: SITE,
        crawlId: AUDIT,
        ruleResults: shell,
        pageStatuses: fixture.statuses,
        now: T_NOW + 5,
        completeStore: {
          crawledUrls: fixture.crawled,
          untouchedCarried: async () => {
            async function* pages(): AsyncGenerator<UntouchedSamplePage> {
              yield {
                normalizedUrl: crawledPage(4),
                untouched: true,
                sample: [row(crawledPage(4), ruleA.id, "check-1", "", PRIOR)],
              };
            }
            return {
              pages: pages(),
              aggregate: { findings: 0, unrenderedFindings: 0, rules: [], classes: [] },
            };
          },
        },
      }),
    ).rejects.toThrow(/crawled or removed/);
  });

  test("a sample row the aggregate cannot add exactly is refused", async () => {
    const fixture = everyShape();
    const store = seed(fixture);
    const u = backlogPage(1);
    const odd = row(u, ruleA.id, "check-1", "", PRIOR, { payload: '{"items":{"length":0.5}}' });
    await expect(
      runCloudSmartAudits({
        store,
        siteKey: SITE,
        crawlId: AUDIT,
        ruleResults: shell,
        pageStatuses: fixture.statuses,
        now: T_NOW + 5,
        completeStore: {
          crawledUrls: fixture.crawled,
          untouchedCarried: async () => {
            async function* pages(): AsyncGenerator<UntouchedSamplePage> {
              yield { normalizedUrl: u, untouched: true, sample: [odd] };
            }
            return {
              pages: pages(),
              aggregate: { findings: 1, unrenderedFindings: 0, rules: [], classes: [] },
            };
          },
        },
      }),
    ).rejects.toThrow(/exact domain/);
  });

  test("a class total past the safe integer range is refused", async () => {
    // Reachable only with millions of rows in one class; the sum would then
    // depend on the order of addition.
    const fixture = everyShape();
    const store = seed(fixture);
    const u = backlogPage(1);
    const sampled = row(u, ruleA.id, "check-1", "", PRIOR);
    await expect(
      runCloudSmartAudits({
        store,
        siteKey: SITE,
        crawlId: AUDIT,
        ruleResults: shell,
        pageStatuses: fixture.statuses,
        now: T_NOW + 5,
        completeStore: {
          crawledUrls: fixture.crawled,
          untouchedCarried: async () => {
            const { aggregate, sample } = aggregateUntouchedCarried([
              { normalizedUrl: u, rows: [sampled], rendered: true, active: true },
            ]);
            async function* pages() {
              yield* sample;
            }
            return {
              pages: pages(),
              aggregate: {
                ...aggregate,
                classes: aggregate.classes.map((c) => ({ ...c, occurrences: Number.MAX_SAFE_INTEGER + 1 })),
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/safe integer range/);
  });

  test("totals that miss a sampled class are refused, not published short", async () => {
    const fixture = everyShape();
    const store = seed(fixture);
    const u = backlogPage(1);
    await expect(
      runCloudSmartAudits({
        store,
        siteKey: SITE,
        crawlId: AUDIT,
        ruleResults: shell,
        pageStatuses: fixture.statuses,
        now: T_NOW + 5,
        completeStore: {
          crawledUrls: fixture.crawled,
          untouchedCarried: async () => {
            async function* pages(): AsyncGenerator<UntouchedSamplePage> {
              yield { normalizedUrl: u, untouched: true, sample: [row(u, ruleA.id, "check-1", "", PRIOR)] };
            }
            return {
              pages: pages(),
              aggregate: { findings: 1, unrenderedFindings: 0, rules: [], classes: [] },
            };
          },
        },
      }),
    ).rejects.toThrow(/miss rows the sample holds/);
  });
});
