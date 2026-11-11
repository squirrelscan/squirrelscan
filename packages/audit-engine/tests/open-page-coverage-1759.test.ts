// #1759: coverage.openPages says how many known pages with open findings a smart-audit merge
// re-verified and how many it left carried, and splits the carried ones into the pages the crawl
// queued and never fetched (the page budget) and the pages it never found (no longer linked).

import { describe, expect, test } from "bun:test";

import type { FindingState, PageFindingRecord, SitePageRecord } from "@squirrelscan/core-contracts";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";

import { describeSitePagesContract } from "./helpers/site-pages-contract";
import { findingKey } from "../src/merge-core";
import { aggregateUntouchedCarried, type UntouchedCarriedPage } from "../src/complete-store-fold";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { summarizeOpenPages } from "../src/open-page-coverage";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();
  async getFindings(_s: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
  }
  async upsertSitePages(pages: SitePageRecord[]): Promise<void> {
    for (const p of pages) this.pages.set(p.normalizedUrl, { ...p });
  }
  async markPageRemoved(): Promise<void> {}
  async markPagesRemoved(): Promise<void> {}
  async compactFindings(): Promise<number> {
    return 0;
  }
}

// The in-memory store below stands in for the real one: it must keep the same page-row contract.
describeSitePagesContract("open-page-coverage-1759.test.ts MemStore", () => new MemStore());

const RULE = "core/meta-title";
const meta = { id: RULE, name: "Meta title", description: "d", category: "core", scope: "page" as const, severity: "error" as const, weight: 5 };
const page = (i: number) => `https://x.test/p${i}`;
const failing = (i: number) => ({ name: "meta-title", status: "fail", message: "Missing", pageUrl: page(i) });
const passing = (i: number) => ({ name: "meta-title", status: "pass", message: "ok", pageUrl: page(i) });
const ruleResults = (checks: object[]) => ({ [RULE]: { meta, checks } as never });
const statuses = (...is: number[]) => is.map((i) => ({ url: page(i), status: 200 }));

/** Run 1 audits p0..p5, all failing. */
async function seeded(): Promise<MemStore> {
  const store = new MemStore();
  await runCloudSmartAudits({
    store,
    siteKey: "web_1",
    crawlId: "audit_1",
    ruleResults: ruleResults([0, 1, 2, 3, 4, 5].map(failing)),
    pageStatuses: statuses(0, 1, 2, 3, 4, 5),
  });
  return store;
}

/** Run 2 re-crawls p0 (still failing) and p1 (now clean); p2..p5 are not crawled. */
const partial = (extra: Record<string, unknown> = {}) => ({
  siteKey: "web_1",
  crawlId: "audit_2",
  ruleResults: ruleResults([failing(0), passing(1)]),
  pageStatuses: statuses(0, 1),
  ...extra,
});

/** The producer's frontier, each list with the count it was made from. */
const frontier = (queued: string[], notFetched: string[], counts?: { queued?: number; notFetched?: number }) => ({
  queuedUnfetchedUrls: queued,
  queuedUnfetchedCount: counts?.queued ?? queued.length,
  notFetchedUrls: notFetched,
  notFetchedCount: counts?.notFetched ?? notFetched.length,
});

describe("coverage.openPages on the sampled merge (#1759)", () => {
  test("a first audit has no openPages", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: ruleResults([failing(0)]),
      pageStatuses: statuses(0),
    });
    expect(r.coverage.openPages).toBeUndefined();
  });

  test("without the crawl's queue it counts re-verified and carried, and makes no split", async () => {
    const store = await seeded();
    const r = await runCloudSmartAudits({ store, ...partial() });
    expect(r.coverage.openPages).toEqual({ reverified: 2, carried: 4 });
    expect(r.coverage.carriedFindings).toBe(4);
  });

  test("with the queue, pages it found and never fetched are skipped, the rest no longer linked", async () => {
    const store = await seeded();
    const r = await runCloudSmartAudits({
      store,
      ...partial({ frontier: frontier([page(2), page(3), "https://x.test/never-stored"], [page(4)]) }),
    });
    expect(r.coverage.openPages).toEqual({
      reverified: 2,
      carried: 4,
      skippedByBudget: 2,
      notFetched: 1,
      noLongerLinked: 1,
    });
  });

  test("a missing list, or a partial one, drops the split and keeps the counts", async () => {
    const onlyQueued = { queuedUnfetchedUrls: [page(2)], queuedUnfetchedCount: 1 };
    const missing = await runCloudSmartAudits({ store: await seeded(), ...partial({ frontier: onlyQueued as never }) });
    expect(missing.coverage.openPages).toEqual({ reverified: 2, carried: 4 });
    for (const counts of [{ queued: 3 }, { notFetched: 2 }]) {
      const r = await runCloudSmartAudits({
        store: await seeded(),
        ...partial({ frontier: frontier([page(2)], [page(4)], counts) }),
      });
      expect(r.coverage.openPages).toEqual({ reverified: 2, carried: 4 });
    }
  });

  test("an empty queue is a known fact: every carried page is no longer linked", async () => {
    const store = await seeded();
    const r = await runCloudSmartAudits({ store, ...partial({ frontier: frontier([], []) }) });
    expect(r.coverage.openPages).toEqual({ reverified: 2, carried: 4, noLongerLinked: 4 });
  });

  test("a page that came back 404 was re-verified, not carried", async () => {
    const store = await seeded();
    const r = await runCloudSmartAudits({
      store,
      ...partial({ pageStatuses: [...statuses(0, 1), { url: page(2), status: 404 }] }),
    });
    expect(r.coverage.openPages).toEqual({ reverified: 3, carried: 3 });
  });

  test("a clipped resolution signal makes no claim: the pages it leaves out may have been fetched", async () => {
    const store = await seeded();
    const rr = ruleResults([failing(0), passing(1)]);
    const signal = { ...buildResolutionSignal(rr, [page(0), page(1)]), crawledComplete: false, crawledCount: 2 };
    const r = await runCloudSmartAudits({ store, ...partial({ ruleResults: rr, resolutionSignal: signal }) });
    expect(r.coverage.openPages).toBeUndefined();
  });
});

describe("coverage.openPages with untouched pages counted by the store (#1759)", () => {
  async function split(queued: string[] | undefined, withPages = true, notFetched: string[] = []) {
    const store = await seeded();
    const rows = (): PageFindingRecord[] => [...store.findings.values()].filter((f) => f.state === "open");
    return runCloudSmartAudits({
      store,
      ...partial({
        ingestStartedAt: Date.now(),
        ...(queued ? { frontier: frontier(queued, notFetched) } : {}),
        completeStore: {
          crawledUrls: [page(0), page(1)],
          untouchedCarried: async (scope: { crawledUrls: ReadonlySet<string>; removedUrls: ReadonlySet<string>; queuedUnfetchedUrls?: ReadonlySet<string>; notFetchedUrls?: ReadonlySet<string> }) => {
            const untouched: UntouchedCarriedPage[] = [];
            const touched: PageFindingRecord[][] = [];
            for (const f of rows()) {
              if (scope.crawledUrls.has(f.normalizedUrl)) touched.push([f]);
              else untouched.push({ normalizedUrl: f.normalizedUrl, rows: [f], rendered: true, active: true });
            }
            for (const p of untouched) store.findings.set(findingKey(p.normalizedUrl, RULE, "meta-title", p.rows[0]!.locator), { ...p.rows[0]!, provenance: "carried" });
            const { aggregate, sample } = aggregateUntouchedCarried(untouched, scope.queuedUnfetchedUrls, scope.notFetchedUrls);
            async function* pages() {
              for (const rowsOfPage of touched) {
                const url = rowsOfPage[0]!.normalizedUrl;
                yield { normalizedUrl: url, fresh: [], prior: rowsOfPage };
              }
              for (const samplePage of sample) yield samplePage;
            }
            return {
              pages: pages(),
              aggregate: withPages
                ? aggregate
                : { ...aggregate, pages: undefined, pagesQueued: undefined, pagesNotFetched: undefined },
            };
          },
        },
      }),
    });
  }

  test("the store's page counts feed the split", async () => {
    const r = await split([page(2), page(3)], true, [page(4)]);
    expect(r.coverage.openPages).toEqual({
      reverified: 2,
      carried: 4,
      skippedByBudget: 2,
      notFetched: 1,
      noLongerLinked: 1,
    });
  });

  test("without the queue the store's pages are carried with no split", async () => {
    const r = await split(undefined);
    expect(r.coverage.openPages).toEqual({ reverified: 2, carried: 4 });
  });

  test("a store that does not count its untouched pages leaves openPages out", async () => {
    const r = await split([page(2)], false);
    expect(r.coverage.openPages).toBeUndefined();
  });
});

describe("coverage.openPages on a complete store, whose ingest overwrote the priors (#1759)", () => {
  const INGEST = 1_780_000_000_000;
  const row = (i: number, firstSeenAt: number): PageFindingRecord => ({
    siteKey: "web_1",
    normalizedUrl: page(i),
    ruleId: RULE,
    checkName: "meta-title",
    locator: "",
    status: "fail",
    severity: "error",
    message: "Missing",
    fingerprint: `fp${i}`,
    firstSeenAt,
    lastSeenCrawlId: "audit_2",
    lastSeenAt: INGEST,
    provenance: "fresh",
    state: "open",
  });

  async function run(ingestStartedAt: number | undefined) {
    const store = await seeded();
    async function* openPages() {
      // p0 failed before this run (first seen earlier); p9 is a new page the ingest wrote during it.
      yield { normalizedUrl: page(0), fresh: [row(0, INGEST - 1000)], prior: [] };
      yield { normalizedUrl: page(9), fresh: [row(9, INGEST + 5)], prior: [] };
    }
    return runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      now: INGEST + 10,
      ...(ingestStartedAt !== undefined ? { ingestStartedAt } : {}),
      ruleResults: ruleResults([failing(0), failing(9)]),
      pageStatuses: statuses(0, 9),
      completeStore: { openPages: openPages(), crawledUrls: [page(0), page(9)] },
    });
  }

  test("a page first seen during the ingest is new, not re-verified", async () => {
    const r = await run(INGEST);
    expect(r.coverage.openPages).toEqual({ reverified: 1, carried: 0 });
  });

  test("without the ingest stamp a complete store makes no claim", async () => {
    const r = await run(undefined);
    expect(r.coverage.openPages).toBeUndefined();
  });
});

describe("summarizeOpenPages", () => {
  test("nothing open: no figure", () => {
    expect(summarizeOpenPages({ reverified: 0, carried: [] })).toBeUndefined();
  });
  test("all re-verified: no split fields", () => {
    expect(summarizeOpenPages({ reverified: 3, carried: [], reach: () => "unseen" })).toEqual({ reverified: 3, carried: 0 });
  });
  test("failed or skipped frontier rows are found but not fetched", () => {
    const reach = (u: string) => (u === "a" ? "pending" : u === "b" ? "other" : "unseen");
    expect(summarizeOpenPages({ reverified: 1, carried: ["a", "b", "c"], reach })).toEqual({
      reverified: 1,
      carried: 3,
      skippedByBudget: 1,
      notFetched: 1,
      noLongerLinked: 1,
    });
  });
  test("listed pages with no frontier and untouched pages are not given a split", () => {
    expect(summarizeOpenPages({ reverified: 0, carried: ["a"], untouched: { pages: 2, pending: 1 } })).toEqual({ reverified: 0, carried: 3 });
    expect(
      summarizeOpenPages({ reverified: 0, carried: [], untouched: { pages: 3, pending: 1, notFetched: 1 } }),
    ).toEqual({ reverified: 0, carried: 3, skippedByBudget: 1, notFetched: 1, noLongerLinked: 1 });
  });
});

describe("resolvedBy on findings that resolve because their page changed (#1759 b)", () => {
  const redirects = { [page(2)]: { status: 301, to: "https://x.test/new-2" } };
  const withRedirect = (extra: Record<string, unknown> = {}) => {
    // The evidence only labels a resolution the signal already licenses: here the check ran clean on the page.
    const rr = ruleResults([failing(0), passing(1), passing(2)]);
    return {
      ...partial({ ruleResults: rr }),
      pageStatuses: [...statuses(0, 1), { url: page(2), status: 301 }],
      resolutionSignal: { ...buildResolutionSignal(rr, [page(0), page(1), page(2)]), ...extra },
    };
  };
  const row = (store: MemStore, i: number) =>
    [...store.findings.values()].find((f) => f.normalizedUrl === page(i))!;
  const by = (store: MemStore, i: number): unknown =>
    (JSON.parse(row(store, i).payload ?? "{}") as { resolvedBy?: unknown }).resolvedBy;

  test("a 301 page resolves with the status and destination in the row's evidence", async () => {
    const store = await seeded();
    await runCloudSmartAudits({ store, ...withRedirect({ redirectedUrls: redirects }) });
    expect(row(store, 2).state).toBe("resolved");
    expect(by(store, 2)).toEqual({ kind: "redirected", status: 301, to: "https://x.test/new-2" });
    // a page fixed in place carries no page-level reason
    expect(row(store, 1).state).toBe("resolved");
    expect(by(store, 1)).toBeUndefined();
  });

  test("a signal without the field still merges, and the resolution is the same", async () => {
    const store = await seeded();
    await runCloudSmartAudits({ store, ...withRedirect() });
    expect(row(store, 2).state).toBe("resolved");
    expect(by(store, 2)).toBeUndefined();
  });

  test("a 410 page goes stale and names 410; a 404 names 404", async () => {
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...partial({
        pageStatuses: [...statuses(0, 1), { url: page(2), status: 410 }, { url: page(3), status: 404 }],
      }),
    });
    expect(row(store, 2).state).toBe("stale");
    expect(by(store, 2)).toEqual({ kind: "removed", status: 410 });
    expect(by(store, 3)).toEqual({ kind: "removed", status: 404 });
  });

  test("evidence never changes a verdict: a redirect named for a page that still fails does not resolve it", async () => {
    const store = await seeded();
    const rr = ruleResults([failing(0), passing(1)]);
    await runCloudSmartAudits({
      store,
      ...partial({
        ruleResults: rr,
        resolutionSignal: {
          ...buildResolutionSignal(rr, [page(0), page(1)]),
          redirectedUrls: { [page(0)]: { status: 301, to: "https://x.test/elsewhere" } },
        },
      }),
    });
    expect(row(store, 0).state).toBe("open");
    expect(by(store, 0)).toBeUndefined();
  });

  // The cloud shape: a redirect row is not among the crawled pages, so the signal never names it and the
  // check has no result for it. Before the redirect list its findings carried for ever.
  const cloud = (extra: Record<string, unknown> = {}) => {
    const rr = ruleResults([failing(0), passing(1)]);
    return {
      ...partial({ ruleResults: rr }),
      resolutionSignal: { ...buildResolutionSignal(rr, [page(0), page(1)]), ...extra },
    };
  };

  test("a cloud merge resolves a redirected page's findings, with the reason (AC1)", async () => {
    const store = await seeded();
    const r = await runCloudSmartAudits({ store, ...cloud({ redirectedUrls: redirects, redirectedCount: 1 }) });
    expect(row(store, 2).state).toBe("resolved");
    expect(by(store, 2)).toEqual({ kind: "redirected", status: 301, to: "https://x.test/new-2" });
    // the other uncrawled pages still carry
    expect(row(store, 3).state).toBe("open");
    expect(r.coverage.openPages).toMatchObject({ reverified: 3, carried: 3 });
  });

  test("an old signal without the field carries the page, as before", async () => {
    const store = await seeded();
    await runCloudSmartAudits({ store, ...cloud() });
    expect(row(store, 2).state).toBe("open");
  });

  test("a dropped or clipped list never resolves by absence: the count alone, or other pages, resolve nothing", async () => {
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...cloud({
        redirectedCount: 40,
        redirectedUrls: { [page(5)]: { status: 302, to: "https://x.test/new-5" } },
      }),
    });
    expect(row(store, 2).state).toBe("open");
    expect(row(store, 5).state).toBe("resolved");
  });

  test("a redirect that lands on the same page is judged by the ordinary rules, not resolved", async () => {
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...cloud({ redirectedUrls: { [page(2)]: { status: 301, to: `${page(2)}/` } } }),
    });
    expect(row(store, 2).state).toBe("open");
  });

  test("an oversized, non-http or script destination is dropped before it reaches a row", async () => {
    const huge = `https://x.test/${"a".repeat(2100)}`;
    for (const to of [huge, "javascript:alert(1)", "data:text/html,x", "ftp://x.test/f", "not a url", ""]) {
      const store = await seeded();
      await runCloudSmartAudits({
        store,
        ...cloud({ redirectedUrls: { [page(2)]: { status: 301, to } } }),
      });
      expect(row(store, 2).state, to.slice(0, 30)).toBe("open");
      expect(by(store, 2)).toBeUndefined();
    }
    // an oversized source is dropped too
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...cloud({ redirectedUrls: { [`${page(2)}/${"s".repeat(2100)}`]: { status: 301, to: "https://x.test/n" } } }),
    });
    expect(row(store, 2).state).toBe("open");
  });

  test("the cap counts rows visited, not accepted: 10k junk rows stop at it, and a source named __proto__ is only a key", async () => {
    const junk: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) junk[`https://x.test/junk-${i}`] = { status: 200, to: 5 };
    // a valid row past the cap is never reached; one before it is
    const early = { [page(5)]: { status: 302, to: "https://x.test/n5" } };
    junk[page(2)] = { status: 301, to: "https://x.test/n2" };
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...cloud({ redirectedUrls: { ...early, ...junk, ["__proto__" as string]: { status: 301, to: "https://x.test/p" } } as never }),
    });
    expect(row(store, 5).state).toBe("resolved");
    expect(row(store, 2).state).toBe("open");
    expect(({} as { status?: unknown }).status).toBeUndefined();
  });

  test("malformed evidence is ignored, not an error", async () => {
    const store = await seeded();
    await runCloudSmartAudits({
      store,
      ...withRedirect({ redirectedUrls: { [page(2)]: { status: 200, to: 5 } } as never }),
    });
    expect(row(store, 2).state).toBe("resolved");
    expect(by(store, 2)).toBeUndefined();
  });
});
