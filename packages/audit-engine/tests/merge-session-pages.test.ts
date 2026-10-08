// The merge session's site-page answers, bounded by the run (#497).
//
// The session used to copy the site's prior pages into a merged map, a merged
// array, an active set and a render-history set, and the cloud merge copied them
// twice more for its carried pages and the sample's render history, then
// upserted every one of them. On a site with a long history that was most of a
// publish. The session now keeps the prior pages once and this run's changes
// beside them, and answers from those. This file pins the answers to what the
// copies gave, on inputs built to separate them: a url listed twice, pages an
// older audit saw removed, crawled and removed sets that overlap, and pages only
// the unsampled signal crawled.

import { describe, expect, test } from "bun:test";

import type { SitePageRecord } from "@squirrelscan/core-contracts";

import { createMergeSession, type MergeSessionInput } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";

const SITE = "web_497_pages";
const CRAWL = "audit_now";
const NOW = 1_700_000_000_000;

/** Deterministic, so a failing fixture can be replayed from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const url = (i: number) => `https://pages.test/p/${i}`;

function page(normalizedUrl: string, state: SitePageRecord["state"], i: number): SitePageRecord {
  return {
    siteKey: SITE,
    normalizedUrl,
    lastStatus: state === "active" ? 200 : 404,
    state,
    lastSeenCrawlId: `audit_${i % 3}`,
    lastSeenAt: NOW - 1_000 * (i + 1),
  };
}

function fixture(seed: number, withSignal: boolean): MergeSessionInput {
  const r = rng(seed);
  const priorPages: SitePageRecord[] = [];
  for (let i = 0; i < 300; i++) {
    priorPages.push(page(url(i), r() < 0.8 ? "active" : "removed", i));
    // A url listed twice, in either order of states: the last row wins.
    if (r() < 0.05) priorPages.push(page(url(i), r() < 0.5 ? "active" : "removed", i + 7));
  }
  // Pick from known pages and from pages no audit has had.
  const pick = (p: number) => {
    const out = new Set<string>();
    for (let i = 0; i < 360; i++) if (r() < p) out.add(url(i));
    return out;
  };
  const crawledUrls = pick(0.1);
  // Overlaps the crawled set on purpose: the array API does not promise they
  // are disjoint, even though the cloud merge makes them so.
  const removedUrls = pick(0.04);
  const statusByUrl = new Map<string, number>();
  for (const u of crawledUrls) statusByUrl.set(u, 200);
  for (const u of removedUrls) if (r() < 0.5) statusByUrl.set(u, 410);
  return {
    siteKey: SITE,
    crawlId: CRAWL,
    crawledUrls,
    freshFindings: [],
    removedUrls,
    severityByRule: new Map(),
    statusByUrl,
    priorPages,
    now: NOW,
    ...(withSignal
      ? {
          resolution: {
            crawledUrls: new Set([...crawledUrls, ...pick(0.06)]),
            failingByCheck: new Map(),
            notEvaluatedByCheck: new Map(),
            truncatedChecks: new Set(),
          },
        }
      : {}),
  };
}

/** The derivations as they were before #497, copied as the oracle. */
function reference(input: MergeSessionInput) {
  const { siteKey, crawlId, crawledUrls, removedUrls, statusByUrl, priorPages, now, resolution } =
    input;
  const everRendered = new Set<string>();
  for (const p of priorPages) everRendered.add(p.normalizedUrl);
  const sitePageMap = new Map<string, SitePageRecord>();
  for (const p of priorPages) sitePageMap.set(p.normalizedUrl, p);
  const markCrawled = (u: string) => {
    if (removedUrls.has(u)) return;
    sitePageMap.set(u, {
      siteKey,
      normalizedUrl: u,
      lastStatus: statusByUrl.get(u) ?? 200,
      state: "active",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  };
  for (const u of crawledUrls) markCrawled(u);
  if (resolution) for (const u of resolution.crawledUrls) markCrawled(u);
  for (const u of removedUrls) {
    const prior = sitePageMap.get(u);
    sitePageMap.set(u, {
      siteKey,
      normalizedUrl: u,
      lastStatus: statusByUrl.get(u) ?? prior?.lastStatus ?? 404,
      state: "removed",
      lastSeenCrawlId: crawlId,
      lastSeenAt: now,
    });
  }
  const sitePages = Array.from(sitePageMap.values());
  const activePageUrls = new Set(
    sitePages.filter((p) => p.state === "active").map((p) => p.normalizedUrl),
  );
  // runCloudSmartAudits' carried pages.
  const priorState = new Map<string, SitePageRecord["state"]>();
  for (const p of priorPages) priorState.set(p.normalizedUrl, p.state);
  const carriedPageUrls = new Set<string>();
  for (const [u, state] of priorState) {
    if (state === "active" && !crawledUrls.has(u) && !removedUrls.has(u)) carriedPageUrls.add(u);
  }
  return { everRendered, sitePages, activePageUrls, carriedPageUrls };
}

describe("merge session site pages == the copies they replace (#497)", () => {
  const cases = [1, 2, 3, 4, 5, 6].flatMap((seed) => [
    { seed, withSignal: false },
    { seed, withSignal: true },
  ]);

  for (const { seed, withSignal } of cases) {
    test(`seed ${seed}${withSignal ? ", with the unsampled signal" : ""}`, () => {
      const input = fixture(seed, withSignal);
      const ref = reference(input);
      const session = createMergeSession(input, { persist: () => {}, active: () => {} });
      // The fixture has to exercise what it claims to.
      expect(new Set(input.priorPages.map((p) => p.normalizedUrl)).size).toBeLessThan(
        input.priorPages.length,
      );
      expect([...input.crawledUrls].some((u) => input.removedUrls.has(u))).toBe(true);

      expect(session.sitePages).toEqual(ref.sitePages);
      expect([...session.activePageUrls]).toEqual([...ref.activePageUrls]);
      expect(session.activePageCount).toBe(ref.activePageUrls.size);

      const carried = session.carriedPageUrls;
      expect(carried.size).toBe(ref.carriedPageUrls.size);
      expect([...carried]).toEqual([...ref.carriedPageUrls]);

      const everyUrl = Array.from({ length: 400 }, (_, i) => url(i));
      for (const u of everyUrl) {
        expect(session.isActivePage(u)).toBe(ref.activePageUrls.has(u));
        expect(session.everRendered(u)).toBe(ref.everRendered.has(u));
        expect(carried.has(u)).toBe(ref.carriedPageUrls.has(u));
      }

      // Writing only the changed rows over the prior ones leaves the same rows
      // a write of every page would.
      const stored = new Map<string, SitePageRecord>();
      for (const p of input.priorPages) stored.set(p.normalizedUrl, p);
      for (const p of session.changedSitePages) stored.set(p.normalizedUrl, p);
      expect(new Map(stored)).toEqual(new Map(ref.sitePages.map((p) => [p.normalizedUrl, p])));
      expect(session.changedSitePages.length).toBeLessThanOrEqual(
        input.crawledUrls.size +
          input.removedUrls.size +
          (input.resolution?.crawledUrls.size ?? 0),
      );
    });
  }
});

describe("a publish writes the run's pages, not the site's (#497)", () => {
  test("5,000 known pages, 20 crawled, 2 removed: 20 page rows upserted", async () => {
    const pages = new Map<string, SitePageRecord>();
    for (let i = 0; i < 5_000; i++) pages.set(url(i), page(url(i), i % 9 === 0 ? "removed" : "active", i));
    const upserted: SitePageRecord[] = [];
    const store: SmartAuditStore = {
      getFindings: async () => [],
      getSitePages: async () => [...pages.values()],
      upsertFindings: async () => {},
      upsertSitePages: async (rows) => {
        upserted.push(...rows);
        for (const p of rows) pages.set(p.normalizedUrl, p);
      },
      markPageRemoved: async () => {},
      markPagesRemoved: async () => {},
      compactFindings: async () => 0,
    };
    const crawled = Array.from({ length: 20 }, (_, i) => url(i * 250 + 1));
    const removed = [url(3), url(9)];
    const before = new Map(pages);

    const result = await runCloudSmartAudits({
      store,
      siteKey: SITE,
      crawlId: CRAWL,
      ruleResults: {},
      pageStatuses: [
        ...crawled.map((u) => ({ url: u, status: 200 })),
        ...removed.map((u) => ({ url: u, status: 404 })),
      ],
      now: NOW,
      completeStore: {
        crawledUrls: crawled,
        openPages: (async function* () {})(),
      },
    });

    expect(upserted.map((p) => p.normalizedUrl)).toEqual(crawled);
    for (const p of upserted) {
      expect(p).toMatchObject({ state: "active", lastSeenCrawlId: CRAWL, lastSeenAt: NOW });
    }
    // Every other row is as it was.
    for (const [u, p] of pages) if (!crawled.includes(u)) expect(p).toBe(before.get(u)!);
    // Known pages: the prior actives, less the removed active one, plus the
    // crawled pages an older audit had seen removed.
    const priorActive = [...before.values()].filter((p) => p.state === "active").length;
    const revived = crawled.filter((u) => before.get(u)?.state === "removed").length;
    expect(revived).toBeGreaterThan(0);
    expect(result.coverage.knownPages).toBe(priorActive - 1 + revived);
    expect(result.coverage.auditedPages).toBe(20);
  });
});
