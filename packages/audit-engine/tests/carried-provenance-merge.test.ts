// #2063 — a published check the producer tagged `carried` is NOT evidence.
//
// The CLI publishes the UNION of this run's crawl and its own local finding
// store, tagging the replayed half `provenance: "carried"`. The cloud merge used
// to read every check's `pageUrl` as a page crawled this run, so a machine whose
// local store still held findings from an audit weeks earlier turned them into
// cloud findings first seen today, on pages the crawl never visited: 129
// "audited pages" for a 16-page crawl, and a health score that swung 38 points
// between two runs of the same site three minutes apart.
//
// Second half of the same bug: the cloud keyed those pages with a query-BLIND
// normalizer, so 384 `?id=N` pages collapsed into one `page_findings` row.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";

import { resolutionCheckKey, resolutionUrlHash } from "@squirrelscan/core-contracts/resolution";

import { findingKey } from "../src/merge-core";
import { runCloudSmartAudits, type SmartAuditStore } from "../src/merge-promise";
import { buildSkippedPassCounts, buildStreamFindings } from "../src/stream-findings";
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
  id: "meta-title",
  name: "Meta Title",
  description: "Pages should have a title",
  category: "core",
  scope: "page" as const,
  severity: "warning" as const,
  weight: 10,
};

/** Epoch ms for 2026-08-19 — the "last seen" on the real report's carried half. */
const AUGUST = Date.UTC(2026, 7, 19, 12, 0, 0);
const NOW = Date.UTC(2026, 8, 11, 17, 11, 27);

function warnCheck(pageUrl: string, overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "meta-title",
    status: "warn",
    message: "Title is too short",
    pageUrl,
    ...overrides,
  };
}

function passCheck(pageUrl: string): CheckResult {
  return { name: "meta-title", status: "pass", message: "ok", pageUrl };
}

/** The 16 pages this run actually crawled: 2 warn, 14 clean. */
const FRESH_PAGES = Array.from({ length: 16 }, (_, i) => `https://gaijin.test/p/${i}`);
/** 400 pages only the PRODUCER's local store knows about. */
const CARRIED_PAGES = Array.from({ length: 400 }, (_, i) => `https://gaijin.test/old/${i}`);

function freshChecks(): CheckResult[] {
  return [
    ...FRESH_PAGES.slice(0, 2).map((u) => warnCheck(u)),
    ...FRESH_PAGES.slice(2).map((u) => passCheck(u)),
  ];
}

function carriedChecks(): CheckResult[] {
  return CARRIED_PAGES.map((u) => warnCheck(u, { provenance: "carried", lastSeenAt: AUGUST }));
}

describe("#2063 — producer-carried checks are not this run's evidence", () => {
  test("a 16-page crawl published with 400 carried pages audits 16 pages", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta: pageMeta, checks: [...freshChecks(), ...carriedChecks()] },
      },
      // The CLI ships only non-2xx statuses, so the crawled set comes from the
      // fresh checks alone — exactly the shape that laundered before.
      pageStatuses: [],
      now: NOW,
    });

    expect(r.coverage.auditedPages).toBe(16);
    expect(r.coverage.knownPages).toBe(16);
    expect(r.replayedChecksDropped).toBe(400);
    // Every one of those 400 pages is one this cloud site has no record of —
    // the number that separates a stale local store from an ordinary partial
    // re-audit, which replays pages the cloud knows.
    expect(r.replayedUnknownPages).toBe(400);

    // Nothing on a carried page reached the store, so nothing was stamped as
    // first seen today on a page this crawl never opened.
    const persisted = await store.getFindings("web_1");
    expect(persisted).toHaveLength(2);
    for (const f of persisted) {
      expect(CARRIED_PAGES).not.toContain(f.normalizedUrl);
      expect(f.firstSeenAt).toBe(NOW);
    }
    expect([...store.pages.keys()].sort()).toEqual([...FRESH_PAGES].sort());
  });

  test("the carried half cannot move the score", async () => {
    const withCarried = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta: pageMeta, checks: [...freshChecks(), ...carriedChecks()] },
      },
      pageStatuses: [],
      now: NOW,
    });
    const freshOnly = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: { "core/meta-title": { meta: pageMeta, checks: freshChecks() } },
      pageStatuses: [],
      now: NOW,
    });

    expect(withCarried.coverage).toEqual(freshOnly.coverage);
    expect(calculateHealthScore({ results: withCarried.unionRuleResults }).overall).toBe(
      calculateHealthScore({ results: freshOnly.unionRuleResults }).overall,
    );
  });

  test("the cloud's OWN carry still works, with the date the cloud last saw it", async () => {
    const store = new MemStore();
    // Run 1: the cloud crawls and sees /p/0 warn.
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: { "core/meta-title": { meta: pageMeta, checks: freshChecks() } },
      pageStatuses: [],
      now: AUGUST,
    });
    // Run 2: only /p/1 re-crawled. /p/0 is published as CARRIED by the producer
    // — the cloud must carry it off its own store, not off the payload.
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: {
        "core/meta-title": {
          meta: pageMeta,
          checks: [
            warnCheck(FRESH_PAGES[1]!),
            warnCheck(FRESH_PAGES[0]!, { provenance: "carried", lastSeenAt: 1 }),
          ],
        },
      },
      pageStatuses: [],
      now: NOW,
    });

    expect(r.coverage.auditedPages).toBe(1);
    expect(r.coverage.carriedFindings).toBe(1);
    // The producer replayed a page the cloud DOES know, so nothing is unknown:
    // an ordinary partial re-audit must not look like the incident.
    expect(r.replayedChecksDropped).toBe(1);
    expect(r.replayedUnknownPages).toBe(0);
    // The cloud's own last-seen (run 1), NOT the bogus `lastSeenAt: 1` the
    // producer published.
    expect(r.carriedLastSeen.get(`${FRESH_PAGES[0]}|core/meta-title|meta-title`)).toBe(AUGUST);

    const carried = (await store.getFindings("web_1", ["open"])).find(
      (f) => f.normalizedUrl === FRESH_PAGES[0],
    );
    expect(carried!.provenance).toBe("carried");
    expect(carried!.firstSeenAt).toBe(AUGUST);
    expect(carried!.lastSeenAt).toBe(AUGUST); // never re-stamped to publish time
  });

  test("a wholly-carried folded aggregate is refused too", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": {
          meta: pageMeta,
          checks: [
            ...freshChecks(),
            {
              name: "meta-title",
              status: "warn",
              message: "Title is too short (+399 more pages)",
              pages: CARRIED_PAGES,
              details: { aggregated: true, occurrences: 400, pagesTruncated: 400 },
              provenance: "carried",
              lastSeenAt: AUGUST,
            },
          ],
        },
      },
      pageStatuses: [],
      now: NOW,
    });

    expect(r.coverage.auditedPages).toBe(16);
    expect(r.replayedChecksDropped).toBe(400);
    expect(await store.getFindings("web_1")).toHaveLength(2);
  });
});

describe("#2063 — query strings are part of a page's identity", () => {
  const Q1 = "https://gaijin.test/p?id=1";
  const Q2 = "https://gaijin.test/p?id=2";

  test("/p?id=1 and /p?id=2 are two findings, not one", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta: pageMeta, checks: [warnCheck(Q1), warnCheck(Q2)] },
      },
      pageStatuses: [],
      now: NOW,
    });

    expect(r.coverage.auditedPages).toBe(2);
    const urls = (await store.getFindings("web_1")).map((f) => f.normalizedUrl).sort();
    expect(urls).toEqual([Q1, Q2]);
    expect([...store.pages.keys()].sort()).toEqual([Q1, Q2]);
  });

  test("re-crawling one query page resolves only that page's finding", async () => {
    const store = new MemStore();
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta: pageMeta, checks: [warnCheck(Q1), warnCheck(Q2)] },
      },
      pageStatuses: [],
      now: AUGUST,
    });
    // Run 2: /p?id=1 is fixed, /p?id=2 not re-crawled.
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: { "core/meta-title": { meta: pageMeta, checks: [passCheck(Q1)] } },
      pageStatuses: [],
      now: NOW,
    });

    const byUrl = new Map((await store.getFindings("web_1")).map((f) => [f.normalizedUrl, f]));
    expect(byUrl.get(Q1)!.state).toBe("resolved");
    expect(byUrl.get(Q2)!.state).toBe("open");
    expect(byUrl.get(Q2)!.provenance).toBe("carried");
  });

  // A publisher on an older release hashed the resolution signal query-BLIND. If
  // the merge only recognized the new spelling it would read "not in the failing
  // set" and resolve a finding that is still there — so both spellings count, and
  // the only thing an unmatched hash can cause is a carry.
  test("a query-blind resolution signal from an older publisher still carries", async () => {
    const store = new MemStore();
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": { meta: pageMeta, checks: [warnCheck(Q1), warnCheck(Q2)] },
      },
      pageStatuses: [],
      now: AUGUST,
    });

    // Run 2 crawls both pages. Q1's warn was clipped out of the published sample,
    // so the payload carries no check for it at all — only the signal knows.
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: { "core/meta-title": { meta: pageMeta, checks: [warnCheck(Q2)] } },
      pageStatuses: [],
      resolutionSignal: {
        crawledUrls: [Q1, Q2],
        // Hashed the OLD way: `normalizeUrl` collapsed both to https://x.test/p.
        failing: {
          [resolutionCheckKey("core/meta-title", "meta-title")]: [
            resolutionUrlHash("https://gaijin.test/p"),
          ],
        },
      },
      now: NOW,
    });

    const byUrl = new Map((await store.getFindings("web_1")).map((f) => [f.normalizedUrl, f]));
    expect(byUrl.get(Q1)!.state).toBe("open");
    expect(byUrl.get(Q1)!.provenance).toBe("carried");
  });

  test("the trailing slash still collapses, so an existing store is not re-keyed", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        "core/meta-title": {
          meta: pageMeta,
          checks: [warnCheck("https://gaijin.test/about/"), warnCheck("https://gaijin.test/about")],
        },
      },
      pageStatuses: [],
      now: NOW,
    });
    expect(r.coverage.auditedPages).toBe(1);
  });
});

describe("#2063 — the sample sets describe this run only", () => {
  const RULE = "core/meta-title";
  const CHECK = "meta-title";
  /** A page the crawl visited and whose finding the fresh sample clipped out. */
  const CLIPPED = "https://gaijin.test/p/3";

  /**
   * A truncated aggregate: it retains `pages` but declares a bigger
   * `pagesTruncated`, which is the marker that makes its page list a SAMPLE and
   * so non-authoritative for the merge.
   */
  function truncatedAggregate(
    pages: string[],
    total: number,
    overrides: Partial<CheckResult> = {},
  ): CheckResult {
    return {
      name: CHECK,
      status: "warn",
      message: `Title is too short (+${total - 1} more pages)`,
      pages,
      details: { aggregated: true, occurrences: total, pagesTruncated: total },
      ...overrides,
    };
  }

  // Without the replay exclusion the CARRIED aggregate's retained pages join the
  // sample set, and a page it happens to name then reads as "in the sample,
  // produced no fresh finding" — the one shape that resolves a finding the crawl
  // never re-examined. The fresh aggregate is what makes the branch reachable:
  // its sample is the authority, and it clipped this page out.
  test("a carried aggregate's pages never become this run's sample", async () => {
    const store = new MemStore();
    await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: { [RULE]: { meta: pageMeta, checks: freshChecks() } },
      pageStatuses: [],
      now: AUGUST,
    });
    // Run 1 left /p/0 and /p/1 failing. Give /p/3 a finding too, so run 2 has a
    // prior on a page its fresh sample clips.
    await store.upsertFindings([
      {
        siteKey: "web_1",
        normalizedUrl: CLIPPED,
        ruleId: RULE,
        checkName: CHECK,
        locator: "",
        status: "warn",
        severity: "warning",
        message: "Title is too short",
        value: null,
        expected: null,
        payload: null,
        fingerprint: "fp-clipped",
        firstSeenAt: AUGUST,
        lastSeenAt: AUGUST,
        lastSeenCrawlId: "audit_1",
        provenance: "fresh",
        state: "open",
      },
    ]);

    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_2",
      ruleResults: {
        [RULE]: {
          meta: pageMeta,
          checks: [
            // Every page crawled again, so the whole site is in `crawledUrls`.
            ...FRESH_PAGES.map((u) => passCheck(u)),
            // This run's failing pages, SAMPLED — /p/3 was clipped out of it.
            truncatedAggregate([FRESH_PAGES[0]!, FRESH_PAGES[1]!], 40),
            // The producer's replay, whose own sample happens to name /p/3.
            truncatedAggregate([CLIPPED, ...CARRIED_PAGES.slice(0, 99)], 400, {
              provenance: "carried",
              lastSeenAt: AUGUST,
            }),
          ],
        },
      },
      pageStatuses: [],
      now: NOW,
    });

    const clipped = (await store.getFindings("web_1")).find((f) => f.normalizedUrl === CLIPPED);
    expect(clipped!.state).toBe("open");
    expect(clipped!.provenance).toBe("carried");
    // The sampled branch unfolds before it filters, so the aggregate is counted
    // as the 100 per-page checks it stands for, not as one object.
    expect(r.replayedChecksDropped).toBe(100);
  });

  test("an unrendered check is refused on the same terms as a carried one", async () => {
    const store = new MemStore();
    const r = await runCloudSmartAudits({
      store,
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        [RULE]: {
          meta: pageMeta,
          checks: [
            ...freshChecks(),
            warnCheck(CARRIED_PAGES[0]!, { provenance: "unrendered" }),
            truncatedAggregate(CARRIED_PAGES.slice(0, 50), 400, { provenance: "unrendered" }),
          ],
        },
      },
      pageStatuses: [],
      now: NOW,
    });

    expect(r.coverage.auditedPages).toBe(16);
    expect(r.replayedChecksDropped).toBe(51); // 1 per-page + the 50 the aggregate unfolds to
    expect(await store.getFindings("web_1")).toHaveLength(2);
    for (const check of r.unionRuleResults.get(RULE)!.checks) {
      expect(CARRIED_PAGES).not.toContain(check.pageUrl ?? "");
    }
  });
});

describe("#2063 — complete-store mode keeps replays out of the union", () => {
  const RULE = "core/meta-title";
  const SITE_RULE = "crawl/robots-txt";
  const siteMeta = {
    id: "robots-txt",
    name: "Robots.txt",
    description: "A site should serve robots.txt",
    category: "crawl",
    scope: "site" as const,
    severity: "warning" as const,
    weight: 10,
  };
  const CRAWLED = FRESH_PAGES[0]!;
  const REPLAYED = CARRIED_PAGES[0]!;

  /** The staged shell: one real page check, one replay, one replayed aggregate,
   *  and a site-scope check that must survive all of it. */
  function shell() {
    return {
      [RULE]: {
        meta: pageMeta,
        checks: [
          warnCheck(CRAWLED),
          warnCheck(REPLAYED, { provenance: "carried" as const, lastSeenAt: 1 }),
          {
            name: "meta-title",
            status: "warn" as const,
            message: "Title is too short (+399 more pages)",
            pages: CARRIED_PAGES.slice(0, 100),
            details: { aggregated: true, occurrences: 400, pagesTruncated: 400 },
            provenance: "carried" as const,
            lastSeenAt: AUGUST,
          },
        ],
      },
      [SITE_RULE]: {
        meta: siteMeta,
        checks: [{ name: "robots-exists", status: "warn" as const, message: "No robots.txt" }],
      },
    };
  }

  async function* noFindingPages(): AsyncGenerator<PageFindingRecord[]> {
    // This audit ingested nothing for these rules.
  }
  async function* noOpenPages(): AsyncGenerator<{
    normalizedUrl: string;
    fresh: PageFindingRecord[];
    prior: PageFindingRecord[];
  }> {
    // The site has no open findings at all.
  }

  function assertClean(result: Awaited<ReturnType<typeof runCloudSmartAudits>>) {
    // Complete mode does NOT unfold, so the aggregate is refused as one check.
    expect(result.replayedChecksDropped).toBe(2);
    expect(result.coverage.auditedPages).toBe(1);

    const checks = result.unionRuleResults.get(RULE)!.checks;
    for (const check of checks) {
      expect(check.pageUrl ?? "").not.toBe(REPLAYED);
      expect(check.lastSeenAt).toBeUndefined();
      expect(check.pages ?? []).toHaveLength(0);
    }
    expect(checks.map((c) => c.pageUrl)).toEqual([CRAWLED]);

    // A genuine site-scope check is scored from the shell verbatim and must not
    // be swept up by a page-attribution filter.
    expect(result.unionRuleResults.get(SITE_RULE)!.checks).toHaveLength(1);
  }

  test("the materialized variant", async () => {
    const result = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: shell(),
      pageStatuses: [],
      now: NOW,
      completeStore: {
        findingPages: noFindingPages(),
        priorOpenFindings: [],
        crawledUrls: [CRAWLED],
      },
    });
    assertClean(result);
  });

  test("the streamed variant", async () => {
    const result = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: shell(),
      pageStatuses: [],
      now: NOW,
      completeStore: { openPages: noOpenPages(), crawledUrls: [CRAWLED] },
    });
    assertClean(result);
  });
});

describe("#2063 — the container streams this run's evidence only", () => {
  const RULE = "core/meta-title";
  const CRAWLED = FRESH_PAGES[0]!;
  const REPLAYED = CARRIED_PAGES[0]!;

  /** The pre-sample report the container flattens: one real finding, one replay
   *  of each kind, and a replayed aggregate. */
  function ruleResults() {
    return {
      [RULE]: {
        meta: pageMeta,
        checks: [
          warnCheck(CRAWLED),
          warnCheck(REPLAYED, { provenance: "carried" as const, lastSeenAt: AUGUST }),
          warnCheck(CARRIED_PAGES[1]!, { provenance: "unrendered" as const }),
          {
            name: "meta-title",
            status: "warn" as const,
            message: "Title is too short (+9 more pages)",
            pages: CARRIED_PAGES.slice(2, 12),
            details: { aggregated: true, occurrences: 10 },
            provenance: "carried" as const,
            lastSeenAt: AUGUST,
          },
        ],
      },
    };
  }

  // Streaming a replay would persist it under THIS run's crawl id with today's
  // first/last-seen — the complete-store path's version of the laundering the
  // sampled merge refuses.
  test("buildStreamFindings streams the crawl's finding and none of the replays", () => {
    const lines = buildStreamFindings(ruleResults(), NOW);

    expect(lines.map((l) => l.normalizedUrl)).toEqual([CRAWLED]);
    expect(lines[0]!.provenance).toBe("fresh");
    expect(lines[0]!.firstSeenAt).toBe(NOW);
  });

  test("buildSkippedPassCounts does not let a replayed fail make a page dirty", () => {
    // /p/1 is clean apart from a REPLAYED warn, so its pass is a whole-page pass,
    // not a passing sibling on a dirty page. Counting it here would add a pass
    // unit the reconstruction already counts as a clean page.
    const counts = buildSkippedPassCounts({
      [RULE]: {
        checks: [
          warnCheck(CRAWLED),
          { name: "title-length", status: "pass", message: "ok", pageUrl: CRAWLED },
          warnCheck(FRESH_PAGES[1]!, { provenance: "carried" as const, lastSeenAt: AUGUST }),
          { name: "title-length", status: "pass", message: "ok", pageUrl: FRESH_PAGES[1]! },
        ],
      },
    });

    expect(counts).toEqual({ [RULE]: { "title-length": 1 } });
  });
});

describe("#2063 — a rule emptied by the filter still scores its crawled pages", () => {
  const REAL_RULE = "core/meta-title";
  /** Every check this rule published is a replay, so the filter empties it. */
  const EMPTIED_RULE = "content/word-count";
  const wordCountMeta = { ...pageMeta, id: "word-count", name: "Word Count", category: "content" };
  const CRAWLED = FRESH_PAGES[0]!;

  async function* noOpenPages(): AsyncGenerator<{
    normalizedUrl: string;
    fresh: PageFindingRecord[];
    prior: PageFindingRecord[];
  }> {
    // Nothing open for this site.
  }

  // The filter must empty a rule's checks without removing the RULE. The tally
  // fold reads rule membership to hand a page rule its fresh-clean pass count —
  // the crawled pages it found nothing on — so an emptied rule dropped from the
  // shell would silently leave the pass denominator.
  test("its fresh-clean pass count survives the filter", async () => {
    const result = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "web_1",
      crawlId: "audit_1",
      ruleResults: {
        [REAL_RULE]: { meta: pageMeta, checks: [warnCheck(CRAWLED)] },
        [EMPTIED_RULE]: {
          meta: wordCountMeta,
          checks: [
            warnCheck(CARRIED_PAGES[0]!, { provenance: "carried" as const, lastSeenAt: AUGUST }),
            warnCheck(CARRIED_PAGES[1]!, { provenance: "unrendered" as const }),
          ],
        },
      },
      pageStatuses: [],
      now: NOW,
      completeStore: { openPages: noOpenPages(), crawledUrls: [CRAWLED] },
    });

    // The rule survives with no checks at all…
    expect(result.unionRuleResults.get(EMPTIED_RULE)!.checks).toHaveLength(0);
    // …and the one crawled page still counts as a pass for it. Drop the rule key
    // and this entry does not exist.
    const tally = result.scoringTallies!.get(EMPTIED_RULE);
    expect(tally).toBeDefined();
    expect(tally!.tally.passed).toBe(1);
    expect(tally!.tally.warnings).toBe(0);

    expect(result.replayedChecksDropped).toBe(2);
    expect(result.coverage.auditedPages).toBe(1);
  });
});
