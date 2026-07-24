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

import { findingKey, flattenChecks } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { reconstructCompleteResults } from "../src/reconstruct";
import { calculateHealthScore } from "../src/scoring";
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
    completeStore: { ingestedFindings: ingested, crawledUrls: crawled, skippedPassCounts },
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
      completeStore: { ingestedFindings: ingested, crawledUrls: crawled, skippedPassCounts },
    });

    // The passing sibling is counted (1), not lost.
    expect(complete.unionRuleResults.get(faqMeta.id)!.syntheticPassCount).toBe(1);
    // Byte-identical to the sampled path (both 1.5/2 = 75%). Fails pre-#1305 (0.5/1).
    expect(calculateHealthScore({ results: complete.unionRuleResults })).toEqual(
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
      const cScore = calculateHealthScore({ results: complete.unionRuleResults });
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
    const cOverall = calculateHealthScore({ results: complete.unionRuleResults }).overall!;

    // Direction: complete counts every failing page → strictly lower score.
    expect(cOverall).toBeLessThan(sOverall);

    // The sample lost failing pages: its union has ≤100 fail checks; the complete
    // union has all 600.
    const sFails = sample.unionRuleResults
      .get(pageMeta.id)!
      .checks.filter((c) => c.status === "fail").length;
    const cFails = complete.unionRuleResults
      .get(pageMeta.id)!
      .checks.filter((c) => c.status === "fail").length;
    expect(sFails).toBeLessThanOrEqual(DEFAULT_PUBLISH_SAMPLE.maxPagesPerCheck);
    expect(cFails).toBe(600);

    // The complete denominator is the true crawl, so its passRate = 100/700.
    const cRule = complete.unionRuleResults.get(pageMeta.id)!;
    expect(cRule.syntheticPassCount).toBe(100); // 700 crawled − 600 failing
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
      completeStore: { ingestedFindings: ingested, crawledUrls: crawled },
    });
    const s = calculateHealthScore({ results: sample.unionRuleResults });
    const c = calculateHealthScore({ results: complete.unionRuleResults });
    return { s, c, sampleRule: sample.unionRuleResults.get(skipMeta.id)!, completeRule: complete.unionRuleResults.get(skipMeta.id)! };
  }

  test("skip-heavy rule (20 fail, 100 pass, 80 skipped of 200) — complete inflates, bounded", async () => {
    const { s, c, sampleRule, completeRule } = await scores(20, 100, 80);
    // Per-rule pass-ratio: sample = 100/120 = 0.833; complete = 180/200 = 0.90.
    const sampleTotal = sampleRule.checks.length + (sampleRule.syntheticPassCount ?? 0);
    const completeTotal = completeRule.checks.length + (completeRule.syntheticPassCount ?? 0);
    expect(sampleTotal).toBe(120); // evaluated only
    expect(completeTotal).toBe(200); // + 80 skipped counted as passes
    expect(completeRule.syntheticPassCount).toBe(180);

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
      completeStore: { ingestedFindings: ingested, crawledUrls: crawled },
    });
    const sample = await runSample("web_ps", native, crawled);
    expect(calculateHealthScore({ results: complete.unionRuleResults })).toEqual(
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
