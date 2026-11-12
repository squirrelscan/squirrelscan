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

import { findingKey } from "../src/merge-core";
import { describeSitePagesContract } from "./helpers/site-pages-contract";
import {
  runCloudSmartAudits,
  type OpenFindingPage,
  type SmartAuditStore,
} from "../src/merge-promise";
import { findingFingerprint } from "../src/fingerprint";

const SITE = "web_1350";
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


describeSitePagesContract("canonical-variants-merge-1350.test.ts MemStore", () => new MemStore());

const NOW = 1_700_000_000_000;
const H = "https://x.test";
const A = `${H}/contact`;
const AV = `${H}/contact?subject=Billing`;
const B = `${H}/about`;
const C = `${H}/pricing`;
const VARIANTS = [{ page: AV, canonical: A }];

/** Page-scope check results for one run: `failUrls` fail, the rest pass. */
function results(failUrls: string[], passUrls: string[]) {
  const mk = (url: string, status: "fail" | "pass") => ({
    name: CHECK,
    status,
    message: status === "fail" ? "Missing meta description" : "ok",
    pageUrl: url,
  });
  return {
    [RULE]: {
      meta,
      checks: [...failUrls.map((u) => mk(u, "fail")), ...passUrls.map((u) => mk(u, "pass"))],
    },
  };
}

function active(url: string, canonical?: string): SitePageRecord {
  return { ...activePage(url), ...(canonical ? { canonical } : {}) };
}

const statuses = (urls: string[]) => urls.map((url) => ({ url, status: 200 }));

type Mode = "sampled" | "streamed";

async function run(
  store: MemStore,
  mode: Mode,
  crawled: string[],
  fail: string[],
  extra: Record<string, unknown> = {},
) {
  const sampled = mode === "sampled";
  return runCloudSmartAudits({
    store,
    siteKey: SITE,
    crawlId: AUDIT,
    ruleResults: sampled
      ? results(
          fail,
          crawled.filter((u) => !fail.includes(u)),
        )
      : shell,
    pageStatuses: statuses(crawled),
    now: NOW,
    ...(sampled
      ? {}
      : { completeStore: { openPages: openPagesOf(store, AUDIT), crawledUrls: crawled } }),
    ...extra,
  });
}

describe.each(["sampled", "streamed"] as const)("canonical variants in the merge, %s path (#1350)", (mode) => {
  const seed = (variantStored: boolean): MemStore => {
    const store = new MemStore();
    for (const u of [A, AV, B, C]) store.pages.set(u, active(u, variantStored && u === AV ? A : undefined));
    // The variant and the canonical page both carry the same finding; B and C are clean.
    for (const u of [A, AV]) {
      store.findings.set(findingKey(u, RULE, CHECK, ""), row(u, "", PRIOR_AUDIT));
    }
    return store;
  };

  test("a stored variant folds out of knownPages and the carried page count", async () => {
    const store = seed(true);
    // Only B is re-crawled: A and AV (and C) are carried.
    const r = await run(store, mode, [B], [], { countCarriedPagesOutsideCrawl: true });
    expect(r.canonicalVariantOf.get(AV)).toBe(A);
    expect(r.canonicalVariantOf.size).toBe(1);
    expect(r.coverage.auditedPages).toBe(1);
    expect(r.coverage.knownPages).toBe(3); // A, B, C: the variant counts with A
    // A and AV carry a finding: one page once folded.
    expect(r.coverage.carriedPagesOutsideCrawl).toBe(1);
  });

  test("without variants the result is the one it always was", async () => {
    const r = await run(seed(false), mode, [B], []);
    expect(r.canonicalVariantOf.size).toBe(0);
    expect(r.coverage.knownPages).toBe(4);
    expect(r.coverage).not.toHaveProperty("carriedPagesOutsideCrawl");
    const plain = await run(seed(false), mode, [B], [], { canonicalVariantPages: undefined });
    expect(plain.coverage).toEqual(r.coverage);
  });

  test("auditedPages, the score tallies and the union are the same with and without variants (billing)", async () => {
    const storeV = seed(true);
    const store0 = seed(false);
    const withVariants = await run(storeV, mode, [A, AV, B], [A, AV], {
      canonicalVariantPages: VARIANTS,
    });
    const without = await run(store0, mode, [A, AV, B], [A, AV]);
    expect(withVariants.coverage.auditedPages).toBe(3);
    expect(withVariants.coverage.auditedPages).toBe(without.coverage.auditedPages);
    expect(withVariants.canonicalVariantOf.get(AV)).toBe(A);
    expect(withVariants.coverage.knownPages).toBe(without.coverage.knownPages - 1);
    expect(withVariants.persistedFindings).toBe(without.persistedFindings);
    expect(withVariants.unionRuleResults).toEqual(without.unionRuleResults);
    // Both undefined on the sampled path, equal maps on the streamed one.
    expect(withVariants.scoringTallies).toEqual(without.scoringTallies);
    expect(withVariants.reportTotals).toEqual(without.reportTotals);
    // The findings the store holds, row for row (the count alone would miss a rekeyed one).
    const rowsOf = (st: MemStore) =>
      [...st.findings.values()]
        .map((f) => JSON.stringify([f.normalizedUrl, f.ruleId, f.checkName, f.locator, f.state, f.provenance, f.fingerprint, f.lastSeenCrawlId]))
        .sort();
    expect(rowsOf(storeV)).toEqual(rowsOf(store0));
  });

  test("a crawled variant is recorded on its page row, and cleared by a complete list that no longer has it", async () => {
    const store = seed(false);
    await run(store, mode, [A, AV, B], [A, AV], { canonicalVariantPages: VARIANTS });
    expect(store.pages.get(AV)?.canonical).toBe(A);
    expect(store.pages.get(A)).not.toHaveProperty("canonical");
    // Next run: the crawl found no variants at all. An EMPTY list is a report that there are none.
    const later = await run(store, mode, [A, AV, B], [A, AV], { canonicalVariantPages: [] });
    expect(store.pages.get(AV)?.canonical).toBeNull();
    expect(later.canonicalVariantOf.size).toBe(0);
    expect(later.coverage.knownPages).toBe(4); // A, AV, B, C: the variant is a page of its own again
  });

  test("a clipped list only adds: a crawled page missing from it keeps what it had", async () => {
    const store = seed(true); // AV is stored as a variant of A
    const clipped = await run(store, mode, [A, AV, B], [A, AV], {
      canonicalVariantPages: [{ page: C, canonical: A }],
      canonicalVariantsComplete: false,
    });
    expect(store.pages.get(AV)?.canonical).toBe(A); // not cleared: the list was clipped
    expect(clipped.canonicalVariantOf.get(AV)).toBe(A);
    // ...and the same list, complete, would have cleared it.
    const complete = await run(seed(true), mode, [A, AV, B], [A, AV], {
      canonicalVariantPages: [{ page: C, canonical: A }],
    });
    expect(complete.canonicalVariantOf.has(AV)).toBe(false);
  });

  test("a producer that reports no variants keeps what is stored", async () => {
    const store = seed(true);
    await run(store, mode, [A, AV, B], [A, AV]);
    expect(store.pages.get(AV)?.canonical).toBe(A);
  });
});

describe("an untouched split counts its pages as the provider says (#1031)", () => {
  test("a provider that does not count pages leaves the count out", async () => {
    const store = new MemStore();
    store.pages.set(A, active(A));
    store.findings.set(findingKey(A, RULE, CHECK, ""), row(A, "", PRIOR_AUDIT));
    const r = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: AUDIT,
      ruleResults: shell,
      pageStatuses: statuses([B]),
      now: NOW,
      countCarriedPagesOutsideCrawl: true,
      completeStore: {
        crawledUrls: [B],
        untouchedCarried: async () => ({
          pages: (async function* () {})(),
          aggregate: {
            findings: 1,
            unrenderedFindings: 0,
            rules: [],
            classes: [],
          },
        }),
      },
    });
    expect(r.coverage).not.toHaveProperty("carriedPagesOutsideCrawl");
  });

  test("a provider that counts them adds its pages to the touched ones", async () => {
    const store = new MemStore();
    store.pages.set(A, active(A));
    store.pages.set(C, active(C));
    store.findings.set(findingKey(A, RULE, CHECK, ""), row(A, "", PRIOR_AUDIT));
    const r = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: AUDIT,
      ruleResults: shell,
      pageStatuses: statuses([B]),
      now: NOW,
      countCarriedPagesOutsideCrawl: true,
      completeStore: {
        crawledUrls: [B],
        untouchedCarried: async () => ({
          pages: (async function* () {})(),
          aggregate: { findings: 3, unrenderedFindings: 0, pages: 2, rules: [], classes: [] },
        }),
      },
    });
    expect(r.coverage.carriedPagesOutsideCrawl).toBe(2);
  });
});
