// Cloud smart-audits orchestration (#195) — runCloudSmartAudits over an
// in-memory SmartAuditStore. Mirrors the CLI smart-audits behavior for the
// Promise/Worker path: carry un-crawled findings, supersede re-crawled, stale
// 404/410, and score over the union so a partial re-audit can't inflate.

import { describe, expect, test } from "bun:test";

import type {
  FindingState,
  PageFindingRecord,
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";
import { normalizeUrl } from "@squirrelscan/utils/url";

import { foldOverflowChecks, type FoldLimits } from "@squirrelscan/rules/fold";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { calculateHealthScore } from "../src/scoring";

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
    for (const f of findings) this.findings.set(this.key(f), { ...f });
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

// A rule result for a set of pages: pages in `failUrls` get a fail check, the
// rest a pass check (so the denominator covers every crawled page).
function ruleResultsFor(failUrls: string[], passUrls: string[]) {
  const checks = [
    ...failUrls.map((url) => ({
      name: "has-meta-description",
      status: "fail" as const,
      message: "Missing meta description",
      pageUrl: url,
    })),
    ...passUrls.map((url) => ({
      name: "has-meta-description",
      status: "pass" as const,
      message: "ok",
      pageUrl: url,
    })),
  ];
  return { "meta-description": { meta: pageMeta, checks } };
}

const P1 = "https://x.test/";
const P2 = "https://x.test/about";
const P3 = "https://x.test/contact";

describe("runCloudSmartAudits — cloud parity", () => {
  test("first audit persists findings, no carry", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2], [P1, P3]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });
    expect(r.coverage).toEqual({ auditedPages: 3, knownPages: 3, carriedFindings: 0 });
    expect((await store.getFindings("web_1", ["open"])).length).toBe(1);
  });

  test("partial re-audit carries the un-crawled finding (no score inflation)", async () => {
    const store = new MemStore();
    // Run 1: full crawl, P2 fails.
    const full = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2], [P1, P3]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });
    const fullScore = calculateHealthScore({ results: full.unionRuleResults }).overall;

    // Run 2: only P1 re-crawled (clean). P2/P3 not crawled → carry.
    const partial = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: ruleResultsFor([], [P1]),
      pageStatuses: [{ url: P1, status: 200 }],
    });
    expect(partial.coverage.auditedPages).toBe(1);
    expect(partial.coverage.knownPages).toBe(3); // union of all known pages
    expect(partial.coverage.carriedFindings).toBe(1); // P2's fail carried

    // The carried fail must still be in the union → score does NOT inflate.
    const partialScore = calculateHealthScore({ results: partial.unionRuleResults }).overall;
    expect(partialScore).toBe(fullScore);
    expect(partialScore).toBeLessThan(100);
  });

  test("a 404 page stales its carried finding (recovers the score)", async () => {
    const store = new MemStore();
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2], [P1, P3]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });
    // Run 2: P2 now 404 (removed), P1/P3 clean.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: ruleResultsFor([], [P1, P3]),
      pageStatuses: [
        { url: P1, status: 200 },
        { url: P2, status: 404 },
        { url: P3, status: 200 },
      ],
    });
    expect(r.coverage.carriedFindings).toBe(0); // P2 gone, not carried
    expect(r.removedPages).toBe(1);
    // No open findings remain.
    expect((await store.getFindings("web_1", ["open"])).length).toBe(0);
    expect(calculateHealthScore({ results: r.unionRuleResults }).overall).toBe(100);
  });
});

// Published reports arrive FOLDED (#910): over-cap per-rule check arrays collapse
// to per-issue-class aggregates with no pageUrl. runCloudSmartAudits must unfold
// them (#916) or every affected page is silently dropped from the union store and
// the score inflates.
describe("runCloudSmartAudits — folded input (#916)", () => {
  // Small cap forces the fold; a generous page cap keeps the unfold lossless.
  const FOLD: FoldLimits = {
    maxChecks: 3,
    maxItemsPerCheck: 1000,
    maxPagesPerCheck: 2000,
    maxSourcePagesPerItem: 5,
  };
  const FAIL_URLS = Array.from({ length: 6 }, (_, i) => `https://x.test/p/${i}`);

  function foldedFailRule() {
    const perPage = FAIL_URLS.map((url) => ({
      name: "has-meta-description",
      status: "fail" as const,
      message: "Missing meta description",
      pageUrl: url,
    }));
    const folded = foldOverflowChecks(perPage, FOLD);
    // Sanity: this is the publish shape — one aggregate, no pageUrl.
    expect(folded).toHaveLength(1);
    expect(folded[0]!.details?.aggregated).toBe(true);
    expect(folded[0]!.pageUrl).toBeUndefined();
    return { perPage, folded };
  }

  test("a folded over-cap rule persists one open finding per affected page", async () => {
    const store = new MemStore();
    const { folded } = foldedFailRule();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: { "meta-description": { meta: pageMeta, checks: folded } },
      pageStatuses: FAIL_URLS.map((url) => ({ url, status: 200 })),
    });

    const open = await store.getFindings("web_1", ["open"]);
    expect(open.length).toBe(FAIL_URLS.length); // was 0 before the unfold
    expect(new Set(open.map((f) => f.normalizedUrl)).size).toBe(FAIL_URLS.length);
    expect(r.coverage.auditedPages).toBe(FAIL_URLS.length);
  });

  test("folded and un-folded inputs produce the same union score (faithful)", async () => {
    const { perPage, folded } = foldedFailRule();
    const pageStatuses = FAIL_URLS.map((url) => ({ url, status: 200 }));

    const rawStore = new MemStore();
    const raw = await runCloudSmartAudits({
      store: rawStore,
      siteKey: "raw",
      crawlId: "a1",
      ruleResults: { "meta-description": { meta: pageMeta, checks: perPage } },
      pageStatuses,
    });

    const foldStore = new MemStore();
    const fold = await runCloudSmartAudits({
      store: foldStore,
      siteKey: "fold",
      crawlId: "a1",
      ruleResults: { "meta-description": { meta: pageMeta, checks: folded } },
      pageStatuses,
    });

    const rawScore = calculateHealthScore({ results: raw.unionRuleResults }).overall;
    const foldScore = calculateHealthScore({ results: fold.unionRuleResults }).overall;
    expect(foldScore).toBe(rawScore);
    expect(foldScore).toBeLessThan(100);
  });
});

// #1167: publish-time page sampling truncates a folded aggregate's pages[] to a
// SAMPLE (stamping details.pagesTruncated). A page still failing but CLIPPED out
// of the sample is absent from the fresh findings even though it was crawled — the
// merge must CARRY it, not resolve it, or sampling would silently mark it fixed.
describe("runCloudSmartAudits — truncated-sample carry (#1167)", () => {
  // A folded aggregate whose pages[] was sampled: keeps `sampledUrls`, records the
  // true count in details.pagesTruncated when it exceeds the retained length.
  function sampledFailRule(sampledUrls: string[], truncatedTo?: number) {
    return {
      "meta-description": {
        meta: pageMeta,
        checks: [
          {
            name: "has-meta-description",
            status: "fail" as const,
            message: "Missing meta description (+more pages)",
            pages: sampledUrls,
            details: {
              aggregated: true,
              occurrences: truncatedTo ?? sampledUrls.length,
              ...(truncatedTo !== undefined ? { pagesTruncated: truncatedTo } : {}),
            },
          },
        ],
      },
    };
  }

  test("a clipped-but-still-crawled page CARRIES its finding (not resolved)", async () => {
    const store = new MemStore();
    // Run 1: P2 and P3 both fail.
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2, P3], [P1]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });
    expect((await store.getFindings("web_1", ["open"])).length).toBe(2);

    // Run 2: still failing on both, but the published aggregate SAMPLED pages[] to
    // just P2 (pagesTruncated=2). P3 is still crawled (200) but clipped from the
    // sample → its absence is NON-authoritative → carry.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: sampledFailRule([P2], 2),
      pageStatuses: [
        { url: P2, status: 200 },
        { url: P3, status: 200 },
      ],
    });

    expect(r.coverage.carriedFindings).toBe(1); // P3 carried, not resolved
    const open = await store.getFindings("web_1", ["open"]);
    const urls = new Set(open.map((f) => f.normalizedUrl));
    expect(urls.has("https://x.test/contact")).toBe(true); // P3 still open
    expect(open.length).toBe(2); // P2 fresh + P3 carried

    // …AND the carried fail must surface in the UNION (score/report/issue-sync),
    // not just storage — a crawled-but-clipped page's carry can't be gated on the
    // un-crawled carriedPageUrls set or the score re-inflates (the #1167 bug).
    const rule = r.unionRuleResults.get("meta-description")!;
    const p3Fail = rule.checks.find(
      (c) => c.pageUrl === "https://x.test/contact" && c.status === "fail",
    );
    expect(p3Fail).toBeDefined();
    expect(calculateHealthScore({ results: r.unionRuleResults }).overall).toBeLessThan(100);
  });

  test("an UN-truncated aggregate still resolves a genuinely fixed page", async () => {
    const store = new MemStore();
    await runCloudSmartAudits({
      store,
      siteKey: "web_2",
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2, P3], [P1]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });

    // Run 2: aggregate lists ONLY P2 with NO pagesTruncated → the page list is
    // authoritative. P3 crawled + absent → genuinely fixed → resolved.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_2",
      crawlId: "audit_2",
      ruleResults: sampledFailRule([P2]),
      pageStatuses: [
        { url: P2, status: 200 },
        { url: P3, status: 200 },
      ],
    });

    expect(r.coverage.carriedFindings).toBe(0);
    const open = await store.getFindings("web_2", ["open"]);
    expect(open.length).toBe(1); // only P2 remains open
    expect(open[0]!.normalizedUrl).toBe("https://x.test/about");
  });
});

// #1185: the UNSAMPLED resolution signal. #1167's sample guard (above) fixed
// wrong-resolves but starved resolution on >100-page sites: a page crawled
// CLEAN but clipped from every published sample could never resolve its carried
// finding. The signal carries authoritative per-check failing sets + the full
// crawled-URL list, letting the merge resolve crawled-clean pages regardless of
// sampling — while an absent key, truncated set, or absent signal falls back to
// the exact pre-#1185 behavior.
describe("runCloudSmartAudits — unsampled resolution signal (#1185)", () => {
  const RULE = "meta-description";
  const CHECK = "has-meta-description";
  const KEY = `${RULE}|${CHECK}`;
  const h = (url: string) => resolutionUrlHash(normalizeUrl(url));

  // Run-2 publish shape: sampled aggregate keeping only `sampledUrls`, with the
  // sample marked truncated (the #1167 guard would CARRY clipped pages).
  function sampledFail(sampledUrls: string[], trueCount: number) {
    return {
      [RULE]: {
        meta: pageMeta,
        checks: [
          {
            name: CHECK,
            status: "fail" as const,
            message: "Missing meta description (+more pages)",
            pages: sampledUrls,
            details: { aggregated: true, occurrences: trueCount, pagesTruncated: trueCount },
          },
        ],
      },
    };
  }

  async function seedBothFailing(store: MemStore, siteKey: string) {
    await runCloudSmartAudits({
      store,
      siteKey,
      crawlId: "audit_1",
      ruleResults: ruleResultsFor([P2, P3], [P1]),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
    });
    expect((await store.getFindings(siteKey, ["open"])).length).toBe(2);
  }

  test("crawled-clean page clipped from the sample RESOLVES via the signal (sample-guard override)", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_1");

    // Run 2: only P2 still fails; the published sample is truncated so the
    // #1167 guard alone would carry P3. The signal's unsampled failing set says
    // P3 is clean → resolve, despite the truncated sample.
    const signal: ResolutionSignal = {
      crawledUrls: [P1, P2, P3],
      failing: { [KEY]: [h(P2)] },
    };
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 2),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
      resolutionSignal: signal,
    });

    expect(r.coverage.carriedFindings).toBe(0);
    const open = await store.getFindings("web_1", ["open"]);
    expect(open.map((f) => f.normalizedUrl)).toEqual(["https://x.test/about"]); // only P2
    const p3 = (await store.getFindings("web_1", ["resolved"])).find(
      (f) => f.normalizedUrl === "https://x.test/contact",
    );
    expect(p3).toBeDefined();
    expect(p3!.lastSeenCrawlId).toBe("audit_2");
  });

  test("page crawled clean per the signal ONLY (absent from the whole sampled payload) resolves, and the score recovers", async () => {
    // Without the signal (today): P3 has no checks in the payload and no
    // pageStatuses entry → treated un-crawled → carried forever.
    const noSignalStore = new MemStore();
    await seedBothFailing(noSignalStore, "web_ns");
    const noSignal = await runCloudSmartAudits({
      store: noSignalStore,
      siteKey: "web_ns",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 2),
      pageStatuses: [{ url: P2, status: 200 }],
    });
    expect(noSignal.coverage.carriedFindings).toBe(1); // P3 starved

    // With the signal: P3 in crawledUrls, absent from the failing set → resolved.
    const store = new MemStore();
    await seedBothFailing(store, "web_2");
    const withSignal = await runCloudSmartAudits({
      store,
      siteKey: "web_2",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 2),
      pageStatuses: [{ url: P2, status: 200 }],
      resolutionSignal: { crawledUrls: [P2, P3], failing: { [KEY]: [h(P2)] } },
    });

    expect(withSignal.coverage.carriedFindings).toBe(0);
    expect((await store.getFindings("web_2", ["open"])).map((f) => f.normalizedUrl)).toEqual([
      "https://x.test/about",
    ]);

    // Density/score recovery: the carried warn is gone from the union, and P3
    // (still NOT in the scoring crawledUrls) counts as a clean carried page —
    // synthetic pass — so the union score strictly recovers.
    const scoreWithout = calculateHealthScore({ results: noSignal.unionRuleResults }).overall;
    const scoreWith = calculateHealthScore({ results: withSignal.unionRuleResults }).overall;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
    const union = withSignal.unionRuleResults.get(RULE)!;
    expect(union.checks.some((c) => c.pageUrl === "https://x.test/contact")).toBe(false);
    expect(union.syntheticPassCount ?? 0).toBeGreaterThan(0); // P3 counts as clean carried
  });

  test("still-failing page clipped from the sample CARRIES (hash present in the failing set)", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_3");

    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_3",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 2),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
      resolutionSignal: { crawledUrls: [P1, P2, P3], failing: { [KEY]: [h(P2), h(P3)] } },
    });

    expect(r.coverage.carriedFindings).toBe(1); // P3 still failing → carried
    const open = await store.getFindings("web_3", ["open"]);
    expect(new Set(open.map((f) => f.normalizedUrl))).toEqual(
      new Set(["https://x.test/about", "https://x.test/contact"]),
    );
  });

  test("key ABSENT from the signal (rule didn't run this cycle) → carried finding untouched", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_4");

    // Run 2's report doesn't include the rule at all (disabled/scoped out) and
    // the signal has no key for it. P3 is signal-crawled, but an absent key is
    // NO signal — never resolve on absence.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_4",
      crawlId: "audit_2",
      ruleResults: {},
      pageStatuses: [],
      resolutionSignal: { crawledUrls: [P1, P2, P3], failing: {} },
    });

    expect(r.coverage.carriedFindings).toBe(2);
    expect((await store.getFindings("web_4", ["open"])).length).toBe(2);
  });

  test("key marked TRUNCATED falls back to the #1167 sample guard (carry)", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_5");

    // The signal's own set was clipped (fold cap / budget): hash-absent proves
    // nothing, so the clipped-from-sample P3 must carry exactly as pre-#1185.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_5",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 2),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
      resolutionSignal: {
        crawledUrls: [P1, P2, P3],
        failing: { [KEY]: [h(P2)] },
        truncated: [KEY],
      },
    });

    expect(r.coverage.carriedFindings).toBe(1);
    const open = await store.getFindings("web_5", ["open"]);
    expect(new Set(open.map((f) => f.normalizedUrl))).toEqual(
      new Set(["https://x.test/about", "https://x.test/contact"]),
    );
  });

  test("EMPTY key (all-pass check class) resolves every crawled page's finding", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_6");

    // Run 2: the check ran everywhere and passed everywhere — the sampled
    // payload has pass checks only for the sampled window, but the signal's
    // empty key is authoritative for every crawled page.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_6",
      crawlId: "audit_2",
      ruleResults: ruleResultsFor([], [P1]),
      pageStatuses: [{ url: P1, status: 200 }],
      resolutionSignal: { crawledUrls: [P1, P2, P3], failing: { [KEY]: [] } },
    });

    expect(r.coverage.carriedFindings).toBe(0);
    expect((await store.getFindings("web_6", ["open"])).length).toBe(0);
    expect(calculateHealthScore({ results: r.unionRuleResults }).overall).toBe(100);
  });

  test("page the check SKIPPED (notEvaluated) does not resolve, even though it's absent from failing", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_7");

    // Run 2: the check evaluated P2 (still failing) but was SKIPPED on P3 — a
    // real shape (perf/ttfb emits `skipped` when timing data is missing). P3 is
    // absent from `failing` WITHOUT being clean, so resolving it would silently
    // delete a live finding. `notEvaluated` is what makes absence non-evidence.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_7",
      crawlId: "audit_2",
      ruleResults: sampledFail([P2], 1),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
      resolutionSignal: {
        crawledUrls: [P1, P2, P3],
        failing: { [KEY]: [h(P2)] },
        notEvaluated: { [KEY]: [h(P3)] },
      },
    });

    expect(r.coverage.carriedFindings).toBe(1);
    const open = await store.getFindings("web_7", ["open"]);
    expect(new Set(open.map((f) => f.normalizedUrl))).toEqual(
      new Set(["https://x.test/about", "https://x.test/contact"]),
    );
  });
  test("signal-confirmed still-failing carry REFRESHES last-seen; an unevaluated carry does not", async () => {
    const store = new MemStore();
    await seedBothFailing(store, "web_8");

    // The published sample keeps only P1, so both prior findings (P2, P3) are
    // clipped out of it and take a carry path. But they are NOT equivalent: the
    // unsampled signal positively confirms P2 is still failing, while P3 was
    // never evaluated. The dashboard's "carried forward" badge reads
    // lastSeenAt, so stamping them alike makes a reconfirmed finding look as
    // stale as one nobody checked.
    const now = 1_777_000_000_000;
    await runCloudSmartAudits({
      store,
      siteKey: "web_8",
      crawlId: "audit_2",
      ruleResults: sampledFail([P1], 3),
      pageStatuses: [P1, P2, P3].map((url) => ({ url, status: 200 })),
      resolutionSignal: {
        crawledUrls: [P1, P2, P3],
        failing: { [KEY]: [h(P1), h(P2)] },
        notEvaluated: { [KEY]: [h(P3)] },
      },
      now,
    });

    const open = await store.getFindings("web_8", ["open"]);
    const byUrl = new Map(open.map((f) => [f.normalizedUrl, f]));
    const confirmed = byUrl.get("https://x.test/about")!;
    const unevaluated = byUrl.get("https://x.test/contact")!;

    expect(confirmed.provenance).toBe("carried");
    expect(confirmed.lastSeenAt).toBe(now);
    expect(confirmed.lastSeenCrawlId).toBe("audit_2");
    // Never evaluated this run — stamps must stay at the seeding crawl.
    expect(unevaluated.lastSeenCrawlId).toBe("audit_1");
    expect(unevaluated.lastSeenAt).not.toBe(now);
  });
});
