// The CARRIED side of the publish merge, bounded (#1876) — THE EQUIVALENCE GATE.
//
// #1873 bounded the fresh side: this audit's findings stream out of the store a
// page at a time and fold into per-rule tallies. The carried side stayed an array:
// every open finding the site had outside this run was loaded, indexed by key,
// walked twice, replayed as a CheckResult and folded into the report — about
// 4.8 KiB per carried finding, 329 MiB at 60,000 of them against a 128 MB isolate.
//
// Now both halves of a page arrive together from one cursor and the merge decides
// each prior as it goes past. This file pins that the two produce the SAME audit:
// same tallies, same score, same coverage, same rows left in the store. The
// fixtures deliberately include the three shapes the streaming driver could get
// wrong and the array driver could not — a page holding fresh AND carried findings,
// a page removed this run, and a rule carrying more findings than the report keeps.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { DEFAULT_FOLD_LIMITS, foldOverflowChecks } from "@squirrelscan/rules/fold";

import { computeMerge, findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type CloudSmartAuditsResult,
  type OpenFindingPage,
  type SmartAuditStore,
} from "../src/merge-promise";
import { calculateHealthScoreFromTallies } from "../src/scoring";
import { findingFingerprint } from "../src/fingerprint";

const SITE = "web_1876";
const AUDIT = "audit_2";
const PRIOR_AUDIT = "audit_1";
const RULE = "content/meta-description";
const CHECK = "has-meta-description";

const meta = {
  id: RULE,
  name: "Meta Description",
  description: "Pages should have a meta description",
  category: "content",
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
};

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  /** Set on the streaming store so a fallback to the unbounded read is a failure. */
  refuseWholeRead = false;
  upsertCalls = 0;

  private key(f: {
    normalizedUrl: string;
    ruleId: string;
    checkName: string;
    locator: string;
  }) {
    return findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator);
  }
  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    if (this.refuseWholeRead) {
      throw new Error("getFindings: the streaming path must never load the whole open set");
    }
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    this.upsertCalls += 1;
    for (const f of findings) {
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
      lastSeenAt: 1_700_000_000_000,
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
    for (const p of pages) {
      await this.markPageRemoved(siteKey, p.normalizedUrl, crawlId, p.lastStatus);
    }
  }
  async compactFindings(): Promise<number> {
    return 0;
  }
}

function row(
  normalizedUrl: string,
  locator: string,
  auditId: string,
  overrides: Partial<PageFindingRecord> = {},
): PageFindingRecord {
  const message = `Missing meta description${locator ? `: ${locator}` : ""}`;
  return {
    siteKey: SITE,
    normalizedUrl,
    ruleId: RULE,
    checkName: CHECK,
    locator,
    status: "fail",
    severity: meta.severity,
    message,
    value: null,
    expected: null,
    payload: locator ? JSON.stringify({ items: [{ id: locator, label: locator }], i: 0 }) : null,
    fingerprint: findingFingerprint("fail", message, null, null),
    firstSeenAt: 1_600_000_000_000,
    lastSeenCrawlId: auditId,
    lastSeenAt: 1_600_000_000_000,
    provenance: "fresh",
    state: "open",
    ...overrides,
  };
}

function activePage(normalizedUrl: string): SitePageRecord {
  return {
    siteKey: SITE,
    normalizedUrl,
    lastStatus: 200,
    state: "active",
    lastSeenCrawlId: PRIOR_AUDIT,
    lastSeenAt: 1_600_000_000_000,
  };
}

/** The shell the container stages: rule meta, no per-page checks. */
const shell = { [RULE]: { meta, checks: [] as CheckResult[] } };

/**
 * The API's cursor, in memory: every OPEN finding for the site in page order, one
 * page per item, split by which audit last saw it.
 */
async function* openPagesOf(store: MemStore, auditId: string): AsyncGenerator<OpenFindingPage> {
  const byPage = new Map<string, PageFindingRecord[]>();
  const sorted = [...store.findings.values()]
    .filter((f) => f.state === "open")
    .sort((a, b) => {
      const ka = findingKey(a.normalizedUrl, a.ruleId, a.checkName, a.locator);
      const kb = findingKey(b.normalizedUrl, b.ruleId, b.checkName, b.locator);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  for (const f of sorted) {
    const rows = byPage.get(f.normalizedUrl);
    if (rows) rows.push(f);
    else byPage.set(f.normalizedUrl, [f]);
  }
  for (const [normalizedUrl, rows] of byPage) {
    yield {
      normalizedUrl,
      fresh: rows.filter((f) => f.lastSeenCrawlId === auditId),
      prior: rows.filter((f) => f.lastSeenCrawlId !== auditId),
    };
  }
}

/** The pre-#1876 inputs: this audit's findings streamed, the priors materialized. */
async function* freshPagesOf(store: MemStore, auditId: string) {
  for await (const page of openPagesOf(store, auditId)) {
    if (page.fresh.length > 0) yield page.fresh as PageFindingRecord[];
  }
}

interface Fixture {
  /** Rows already in the store when the finalize starts (ingest + backlog). */
  rows: PageFindingRecord[];
  /** site_pages rows a previous audit left. */
  pages: string[];
  /** `resolutionSignal.crawledUrls` for this run. */
  crawled: string[];
  /** Per-page HTTP status for this run. */
  statuses?: Array<{ url: string; status: number }>;
}

function seed(fixture: Fixture): MemStore {
  const store = new MemStore();
  for (const r of fixture.rows) {
    store.findings.set(findingKey(r.normalizedUrl, r.ruleId, r.checkName, r.locator), r);
  }
  for (const p of fixture.pages) store.pages.set(p, activePage(p));
  return store;
}

async function runStreamed(fixture: Fixture): Promise<[CloudSmartAuditsResult, MemStore]> {
  const store = seed(fixture);
  const result = await runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: AUDIT,
    ruleResults: shell,
    pageStatuses: fixture.statuses ?? fixture.crawled.map((url) => ({ url, status: 200 })),
    now: 1_700_000_000_000,
    completeStore: {
      openPages: openPagesOf(store, AUDIT),
      crawledUrls: fixture.crawled,
    },
  });
  return [result, store];
}

async function runMaterialized(fixture: Fixture): Promise<[CloudSmartAuditsResult, MemStore]> {
  const store = seed(fixture);
  const result = await runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: AUDIT,
    ruleResults: shell,
    pageStatuses: fixture.statuses ?? fixture.crawled.map((url) => ({ url, status: 200 })),
    now: 1_700_000_000_000,
    completeStore: {
      findingPages: freshPagesOf(store, AUDIT),
      priorOpenFindings: [...store.findings.values()].filter(
        (f) => f.state === "open" && f.lastSeenCrawlId !== AUDIT,
      ),
      crawledUrls: fixture.crawled,
    },
  });
  return [result, store];
}

/** Store contents reduced to what the merge is responsible for. */
function storeState(store: MemStore): Array<[string, string, string]> {
  return [...store.findings.values()]
    .map(
      (f) =>
        [
          findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator),
          f.state,
          f.provenance,
        ] as [string, string, string],
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Everything a caller reads off the result, order-normalized. */
function surface(result: CloudSmartAuditsResult) {
  const checks = result.unionRuleResults.get(RULE)?.checks ?? [];
  return {
    score: calculateHealthScoreFromTallies(result.scoringTallies!, result.unionRuleResults),
    tally: result.scoringTallies!.get(RULE)!.tally,
    coverage: result.coverage,
    persistedFindings: result.persistedFindings,
    removedPages: result.removedPages,
    syntheticPassCount: result.unionRuleResults.get(RULE)?.syntheticPassCount,
    checks: checks
      .map((c) => `${c.status}|${c.pageUrl ?? ""}|${c.message}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

describe("streamed carried merge == materialized carried merge (#1876)", () => {
  /**
   * One fixture holding every shape at once: this run's ingest, a backlog the run
   * never touches, a prior the run re-crawled clean, a page that 404'd with an open
   * prior on it, and a page carrying BOTH this run's findings and an older one.
   */
  function everyShape(): Fixture {
    const crawled = Array.from({ length: 6 }, (_, i) => `https://x.test/p/${i}`);
    const carriedPages = Array.from({ length: 5 }, (_, i) => `https://x.test/old/${i}`);
    const removed = "https://x.test/gone";
    // A page with ingested findings that is NOT in the crawled set — the merge
    // carries its priors, so its fresh and carried findings must fold together.
    const overlap = "https://x.test/uncrawled-but-ingested";

    const rows: PageFindingRecord[] = [
      // This run's ingest: 2 of the 6 crawled pages fail.
      row(crawled[0]!, "", AUDIT),
      row(crawled[1]!, "", AUDIT),
      // A prior the run re-crawled and did NOT re-observe → resolves.
      row(crawled[2]!, "", PRIOR_AUDIT),
      // The backlog: 3 of the 5 un-crawled pages carry, 2 stay clean.
      row(carriedPages[0]!, "", PRIOR_AUDIT),
      row(carriedPages[1]!, "item-a", PRIOR_AUDIT),
      row(carriedPages[1]!, "item-b", PRIOR_AUDIT),
      row(carriedPages[2]!, "", PRIOR_AUDIT),
      // Removed this run → its open prior stales.
      row(removed, "", PRIOR_AUDIT),
      // The overlap page: one locator ingested this run, one left by the last.
      row(overlap, "item-new", AUDIT),
      row(overlap, "item-old", PRIOR_AUDIT),
    ];
    return {
      rows,
      pages: [...crawled, ...carriedPages, removed, overlap],
      crawled,
      statuses: [
        ...crawled.map((url) => ({ url, status: 200 })),
        { url: removed, status: 404 },
      ],
    };
  }

  test("the whole result surface is identical, and so is what is left in the store", async () => {
    const fixture = everyShape();
    const [streamed, streamedStore] = await runStreamed(fixture);
    const [materialized, materializedStore] = await runMaterialized(fixture);

    expect(surface(streamed)).toEqual(surface(materialized));
    expect(storeState(streamedStore)).toEqual(storeState(materializedStore));
  });

  test("the streaming path never falls back to loading the whole open set", async () => {
    const fixture = everyShape();
    const store = seed(fixture);
    store.refuseWholeRead = true;
    const result = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: AUDIT,
      ruleResults: shell,
      pageStatuses: fixture.statuses!,
      now: 1_700_000_000_000,
      completeStore: { openPages: openPagesOf(store, AUDIT), crawledUrls: fixture.crawled },
    });
    // 5 carried: 4 on the three un-crawled backlog pages (one holds two items),
    // plus the one on the ingested-but-uncrawled page.
    expect(result.coverage.carriedFindings).toBe(5);
  });

  test("a page holding BOTH this run's findings and an older one folds as one page", async () => {
    // The invariant the page-boundary contract exists for: `addChecksToTally`
    // clamps fail units per (checkName, pageUrl) WITHIN one call, so folding the
    // overlap page's two locators in two calls would count the bucket twice.
    const overlap = "https://x.test/uncrawled-but-ingested";
    const fixture: Fixture = {
      rows: [row(overlap, "item-new", AUDIT), row(overlap, "item-old", PRIOR_AUDIT)],
      pages: [overlap],
      crawled: [],
      statuses: [],
    };
    const [streamed] = await runStreamed(fixture);
    const [materialized] = await runMaterialized(fixture);
    expect(streamed.scoringTallies!.get(RULE)!.tally).toEqual(
      materialized.scoringTallies!.get(RULE)!.tally,
    );
    // ONE (check, page) bucket, two item findings in it: 2 fail units, not 2 buckets.
    expect(streamed.scoringTallies!.get(RULE)!.tally.failUnits).toBe(2);
    expect(streamed.scoringTallies!.get(RULE)!.tally.failed).toBe(2);
  });

  test("a carried finding's replayed check carries its provenance and last-seen date", async () => {
    const fixture = everyShape();
    const [streamed] = await runStreamed(fixture);
    const [materialized] = await runMaterialized(fixture);
    const carried = streamed.unionRuleResults
      .get(RULE)!
      .checks.find((c) => c.pageUrl === "https://x.test/old/0")!;
    // Stamped at construction rather than from a per-finding map, so the streaming
    // path needs no `carriedLastSeen` — but it must say exactly what that map said.
    expect(carried.provenance).toBe("carried");
    expect(carried.lastSeenAt).toBe(
      materialized.carriedLastSeen.get(`https://x.test/old/0|${RULE}|${CHECK}`),
    );
    expect(streamed.carriedLastSeen.size).toBe(0);
  });
});

describe("the report's carried side is bounded per rule (#1876)", () => {
  // Comfortably past the per-rule sample, so the class is folded and stamped.
  const OVER_CAP = 520;
  /** Mirrors CARRIED_REPORT_SAMPLE_PER_RULE, which the module keeps private. */
  const CARRIED_SAMPLE_PER_RULE = 25;

  test("past the cap the checks stop growing but the occurrence count stays true", async () => {
    const carriedPages = Array.from(
      { length: OVER_CAP },
      (_, i) => `https://x.test/backlog/${String(i).padStart(4, "0")}`,
    );
    const fixture: Fixture = {
      rows: carriedPages.map((u) => row(u, "", PRIOR_AUDIT)),
      pages: carriedPages,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);

    // One aggregate for the rule's single issue class, NOT 500 per-page checks:
    // a rule this far over the cap folded to a handful of aggregates before the
    // bound existed, and publishing the retained sample verbatim would make the
    // report bigger than it used to be, not smaller.
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.details?.aggregated).toBe(true);

    // The 20 dropped ones survive as numbers: the fold sums `occurrences` and
    // maxes `pagesTruncated` across the group, so the aggregate the report stores
    // still reports every occurrence and every affected page.
    expect(checks[0]!.details?.occurrences).toBe(OVER_CAP);
    expect(checks[0]!.details?.pagesTruncated).toBe(OVER_CAP);
    expect(checks[0]!.message).toContain(`(+${OVER_CAP - 1} more pages)`);
    expect(checks[0]!.provenance).toBe("carried");

    // And it survives the publish fold the caller runs over the whole rule.
    const refolded = foldOverflowChecks([...checks], DEFAULT_FOLD_LIMITS);
    expect(refolded[0]!.details?.occurrences).toBe(OVER_CAP);

    // And the SCORE saw all of them — the bound is on the report body only.
    expect(streamed.scoringTallies!.get(RULE)!.tally.failed).toBe(OVER_CAP);
    expect(streamed.coverage.carriedFindings).toBe(OVER_CAP);
  });

  test("a class first seen after the budget is spent still reaches the report", async () => {
    // The budget is per RULE, so one loud issue class can spend all of it before a
    // second class is ever seen. Dropping the second class would lose it from the
    // report entirely while its findings stayed open in the store — the counts have
    // to ride on a check, so every class keeps one.
    const loud = Array.from({ length: 200 }, (_, i) => `https://x.test/loud/${i}`);
    const quiet = ["https://x.test/quiet/0", "https://x.test/quiet/1"];
    const fixture: Fixture = {
      rows: [
        ...loud.map((u) => row(u, "", PRIOR_AUDIT)),
        // A different checkName under the same rule = a different issue class,
        // and its pages sort after every loud one, so it is seen last.
        ...quiet.map((u) => ({
          ...row(u, "", PRIOR_AUDIT),
          checkName: "has-og-description",
          message: "Missing og:description",
        })),
      ],
      pages: [...loud, ...quiet],
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);

    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    const quietChecks = checks.filter((c) => c.name === "has-og-description");
    expect(quietChecks).toHaveLength(1);
    expect(quietChecks[0]!.details?.occurrences).toBe(2);
    expect(quietChecks[0]!.details?.pagesTruncated).toBe(2);
    // Its sample is ONE check, which the fold leaves alone, so it would otherwise
    // still read as that single page's finding while standing for two.
    expect(quietChecks[0]!.details?.aggregated).toBe(true);
    expect(quietChecks[0]!.pageUrl).toBeUndefined();
    expect(quietChecks[0]!.message).toContain("(+1 more pages)");
    // And the loud class still reports all 200.
    const loudChecks = checks.filter((c) => c.name === CHECK);
    expect(loudChecks).toHaveLength(1);
    expect(loudChecks[0]!.details?.occurrences).toBe(200);
    // Every carried finding still scored.
    expect(streamed.scoringTallies!.get(RULE)!.tally.failed).toBe(202);
  });

  test("a dropped check's own occurrence and page counts are not lost", async () => {
    // A carried finding can already stand for many: `unfoldAggregateCheck` strips
    // `aggregated` and `occurrences` when it expands a published aggregate but
    // leaves `pagesTruncated`, so the per-page rows the merge stores inherit it,
    // and a rule's own `details` can carry either. Counting each replay as one
    // occurrence and one page would understate the aggregate by whatever the
    // dropped checks were standing for.
    // PADDED: the cursor yields pages in normalized-URL order, so an unpadded
    // "agg/29" would sort before "agg/3" and land INSIDE the retained sample —
    // and the test would pass without exercising a drop at all.
    const backlog = Array.from(
      { length: 30 },
      (_, i) => `https://x.test/agg/${String(i).padStart(2, "0")}`,
    );
    const fixture: Fixture = {
      rows: backlog.map((u, i) => ({
        ...row(u, "", PRIOR_AUDIT),
        // Every replay stands for 2 findings; the LAST one — dropped, because the
        // sample is full by then — also reports 400 affected pages.
        payload: JSON.stringify({
          details: i === backlog.length - 1 ? { occurrences: 2, pagesTruncated: 400 } : { occurrences: 2 },
        }),
      })),
      pages: backlog,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.details?.occurrences).toBe(60);
    expect(checks[0]!.details?.pagesTruncated).toBe(400);
  });

  test("a class the sample saw as all-carried but is not loses the claim", async () => {
    // `foldGroup` stamps "carried" only when EVERY constituent is, so a uniform
    // sample of a mixed class would have the aggregate assert an earlier audit saw
    // findings no audit has ever rendered. The newest date has the mirror problem:
    // it is a max over the group, so a dropped constituent carrying a later one
    // would leave the badge reading stale.
    const rendered = Array.from(
      { length: 30 },
      (_, i) => `https://x.test/seen/${String(i).padStart(2, "0")}`,
    );
    // Sorts AFTER every rendered page, so the sample is full before it is seen and
    // the mixed class is only visible through the counters.
    const unseen = "https://x.test/zz-never";
    const fixture: Fixture = {
      rows: [
        ...rendered.map((u) => ({ ...row(u, "", PRIOR_AUDIT), lastSeenAt: 1_600_000_000_000 })),
        { ...row(unseen, "", PRIOR_AUDIT), lastSeenAt: 1_650_000_000_000 },
      ],
      // `unseen` gets NO site_pages row, so no audit has ever rendered it (#1652).
      pages: rendered,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    // Mixed carried + unrendered: neither marker, which is what folding all 31
    // real checks would have produced.
    expect(checks[0]!.provenance).toBeUndefined();
    expect(checks[0]!.lastSeenAt).toBeUndefined();
    expect(checks[0]!.details?.occurrences).toBe(31);
  });

  test("an all-carried class keeps the NEWEST last-seen, dropped checks included", async () => {
    const backlog = Array.from(
      { length: 30 },
      (_, i) => `https://x.test/dated/${String(i).padStart(2, "0")}`,
    );
    const fixture: Fixture = {
      rows: backlog.map((u, i) => ({
        ...row(u, "", PRIOR_AUDIT),
        // The newest date is on a check the sample drops.
        lastSeenAt: i === backlog.length - 1 ? 1_690_000_000_000 : 1_600_000_000_000,
      })),
      pages: backlog,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.provenance).toBe("carried");
    expect(checks[0]!.lastSeenAt).toBe(1_690_000_000_000);
  });

  test("a dropped check whose occurrence weight floors to zero still counts as lost", async () => {
    // `foldGroup` floors `details.occurrences`, so a check declaring 0.5 adds
    // nothing to either weight. Keying "did this class lose anything" on weight
    // would call such a class complete and skip both the stamp and the provenance
    // reconciliation, losing its pages and its never-rendered status with it.
    // EXACTLY the sample budget, so the zero-weight check below is the ONLY thing
    // dropped — otherwise the other drops' weight would trip a weight-keyed test
    // and this would prove nothing.
    const backlog = Array.from(
      { length: CARRIED_SAMPLE_PER_RULE },
      (_, i) => `https://x.test/frac/${String(i).padStart(2, "0")}`,
    );
    const odd = "https://x.test/zz-odd";
    const fixture: Fixture = {
      rows: [
        ...backlog.map((u) => row(u, "", PRIOR_AUDIT)),
        {
          ...row(odd, "", PRIOR_AUDIT),
          payload: JSON.stringify({ details: { occurrences: 0.5, pagesTruncated: 400 } }),
        },
      ],
      // `odd` has no site_pages row, so nothing has ever rendered it.
      pages: backlog,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.details?.pagesTruncated).toBe(400);
    // Mixed carried + unrendered, so neither marker survives.
    expect(checks[0]!.provenance).toBeUndefined();
  });

  test("a class weighing zero is not rounded UP by the stamp", async () => {
    // `foldGroup` reads a non-positive `occurrences` as "no count declared" and
    // substitutes 1, so stamping the 0 a fractional-weight class genuinely weighs
    // would invent an occurrence the materialized fold does not have.
    const plain = Array.from(
      { length: CARRIED_SAMPLE_PER_RULE - 1 },
      (_, i) => `https://x.test/plain/${String(i).padStart(2, "0")}`,
    );
    const fractional = ["https://x.test/zz-frac-0", "https://x.test/zz-frac-1"];
    const fixture: Fixture = {
      rows: [
        ...plain.map((u) => row(u, "", PRIOR_AUDIT)),
        ...fractional.map((u) => ({
          ...row(u, "", PRIOR_AUDIT),
          payload: JSON.stringify({ details: { occurrences: 0.5 } }),
        })),
      ],
      pages: [...plain, ...fractional],
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const checks = streamed.unionRuleResults.get(RULE)!.checks;
    expect(checks).toHaveLength(1);
    // 24 checks weighing 1, two weighing 0 — the same total the materialized fold
    // reaches over all 26.
    expect(checks[0]!.details?.occurrences).toBe(CARRIED_SAMPLE_PER_RULE - 1);
  });

  test("under the cap the report is exactly what the materialized path builds", async () => {
    const carriedPages = Array.from({ length: 20 }, (_, i) => `https://x.test/backlog/${i}`);
    const fixture: Fixture = {
      rows: carriedPages.map((u) => row(u, "", PRIOR_AUDIT)),
      pages: carriedPages,
      crawled: ["https://x.test/p/0"],
      statuses: [{ url: "https://x.test/p/0", status: 200 }],
    };
    const [streamed] = await runStreamed(fixture);
    const [materialized] = await runMaterialized(fixture);
    expect(surface(streamed)).toEqual(surface(materialized));
    expect(streamed.unionRuleResults.get(RULE)!.checks).toHaveLength(20);
  });
});

describe("computeMerge keeps its array-API contract (#1876)", () => {
  test("a repeated prior key is decided once, as it was before the merge streamed", async () => {
    // The session has no `handledKeys` set — that set's size is the prior count,
    // which is the whole point — so it takes key-unique priors, which is what the
    // page_findings primary key guarantees. The array API has no such guarantee:
    // its caller builds the list, and the pre-#1876 loop ignored a repeat.
    const prior = row("https://x.test/dup", "", PRIOR_AUDIT);
    const merged = computeMerge({
      siteKey: SITE,
      crawlId: AUDIT,
      crawledUrls: new Set<string>(),
      freshFindings: [],
      removedUrls: new Set<string>(),
      severityByRule: new Map([[RULE, meta.severity]]),
      statusByUrl: new Map<string, number>(),
      priorFindings: [prior, { ...prior }],
      priorPages: [activePage("https://x.test/dup")],
      now: 1_700_000_000_000,
    });
    expect(merged.findings).toHaveLength(1);
    expect(merged.persisted).toHaveLength(1);
    expect(merged.findings[0]!.provenance).toBe("carried");
  });

  test("a repeated prior a fresh finding supersedes still hands over the LAST first-seen", async () => {
    // The other half of the same contract, and it points the other way. A
    // superseded prior never reached the old loop's decision — it was read out of
    // an index built by assigning each prior in turn, so the LAST assignment won.
    const url = "https://x.test/dup";
    const base = row(url, "", PRIOR_AUDIT);
    const merged = computeMerge({
      siteKey: SITE,
      crawlId: AUDIT,
      crawledUrls: new Set([url]),
      freshFindings: [
        {
          normalizedUrl: url,
          ruleId: RULE,
          checkName: CHECK,
          locator: "",
          status: "fail",
          message: "Missing meta description",
          value: null,
          expected: null,
          payload: null,
        },
      ],
      removedUrls: new Set<string>(),
      severityByRule: new Map([[RULE, meta.severity]]),
      statusByUrl: new Map([[url, 200]]),
      priorFindings: [
        { ...base, firstSeenAt: 1_500_000_000_000 },
        { ...base, firstSeenAt: 1_400_000_000_000 },
      ],
      priorPages: [activePage(url)],
      now: 1_700_000_000_000,
    });
    expect(merged.persisted).toHaveLength(1);
    expect(merged.persisted[0]!.firstSeenAt).toBe(1_400_000_000_000);
  });
});
