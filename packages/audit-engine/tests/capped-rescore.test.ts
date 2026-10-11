// squirrelscan/repo#2657: the server rescore of a CAPPED report.
//
// The publish capper (repo#2656) keeps a 10-page sample per issue class and no
// per-page pass rows, so the sampled-path rescore can no longer count rows. It
// reads the capper's `checkTallies` for this run's side and the merge for the
// carried side. Every test here publishes the SAME audit twice, once as today's
// uncapped body and once capped, against identically seeded stores, and asserts
// the rescore cannot tell them apart: same health score, category and group
// scores, issue counts and coverage. The merge decisions on a capped body are
// the ones the #1185 resolution signal already makes for clipped pages.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  FindingState,
  HealthScore,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { SCAN_TRUNCATED_SKIP_REASON } from "@squirrelscan/core-contracts/resolution";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import {
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
} from "@squirrelscan/utils/constants";

import { findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type CloudSmartAuditsInput,
  type CloudSmartAuditsResult,
  type SmartAuditStore,
} from "../src/merge-promise";
import { buildCheckTallies, capReportForPublish } from "../src/publish-cap";
import { calculateHealthScore, calculateHealthScoreFromTallies } from "../src/scoring";

class MemStore implements SmartAuditStore {
  findings = new Map<string, PageFindingRecord>();
  pages = new Map<string, SitePageRecord>();

  async getFindings(_siteKey: string, states?: FindingState[]): Promise<PageFindingRecord[]> {
    const all = [...this.findings.values()];
    return states ? all.filter((f) => states.includes(f.state)) : all;
  }
  async getSitePages(): Promise<SitePageRecord[]> {
    return [...this.pages.values()];
  }
  async upsertFindings(findings: PageFindingRecord[]): Promise<void> {
    for (const f of findings) {
      this.findings.set(findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator), { ...f });
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
    for (const p of pages) await this.markPageRemoved(siteKey, p.normalizedUrl, crawlId, p.lastStatus);
  }
  async compactFindings(): Promise<number> {
    return 0;
  }
  clone(): MemStore {
    const copy = new MemStore();
    for (const [k, f] of this.findings) copy.findings.set(k, { ...f });
    for (const [k, p] of this.pages) copy.pages.set(k, { ...p });
    return copy;
  }
}

type Meta = CloudSmartAuditsInput["ruleResults"][string]["meta"];
type Rules = Record<string, { meta: Meta; checks: CheckResult[] }>;

const SITE = "https://shop.test";
const url = (i: number): string => `${SITE}/p/${String(i).padStart(3, "0")}`;
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, i) => from + i);

const meta = (
  id: string,
  category: string,
  scope: "page" | "site",
  severity: "error" | "warning" | "info",
  weight: number,
): Meta => ({ id, name: id, description: `${id} rule`, category, scope, severity, weight }) as Meta;

/** What a page of this audit looks like: which checks fail or warn on it. */
interface PageShape {
  i: number;
  /** HTTP status this run (default 200). */
  status?: number;
  metaMissing?: boolean;
  /** img-alt fail items; `extra` > 0 adds `details.additional`. */
  altItems?: number;
  extra?: number;
  emptyAlt?: boolean;
  /** perf/ttfb: undefined = pass, "slow" = warn, "skipped" = no timing data. */
  ttfb?: "slow" | "skipped";
  /** Advisory warn of a severity-"info" rule (not scored). */
  readability?: boolean;
}

/**
 * A full per-page report, as the producer holds it before publish: every
 * page-scope rule emits one row per page and check name, passes included.
 */
function fullReport(shapes: PageShape[], opts: { robotsMissing?: boolean } = {}) {
  const rows = (fn: (s: PageShape) => CheckResult | CheckResult[] | undefined): CheckResult[] =>
    shapes.flatMap((s) => fn(s) ?? []);
  const ruleResults: Rules = {
    "core/meta-description": {
      meta: meta("core/meta-description", "core", "page", "warning", 10),
      checks: rows((s) => ({
        name: "has-meta-description",
        status: s.metaMissing ? "fail" : "pass",
        message: s.metaMissing ? "Missing meta description" : "Meta description present",
        pageUrl: url(s.i),
      })),
    },
    "a11y/img-alt": {
      meta: meta("a11y/img-alt", "a11y", "page", "error", 8),
      checks: rows((s) => [
        s.altItems
          ? {
              name: "img-alt",
              status: "fail" as const,
              message: `${s.altItems + (s.extra ?? 0)} images missing alt`,
              pageUrl: url(s.i),
              items: range(0, s.altItems).map((k) => ({
                id: `${SITE}/img/${s.i}-${k}.png`,
                sourcePages: [url(s.i)],
              })),
              ...(s.extra ? { details: { additional: s.extra } } : {}),
            }
          : { name: "img-alt", status: "pass" as const, message: "All images have alt", pageUrl: url(s.i) },
        {
          name: "img-alt-empty",
          status: s.emptyAlt ? ("warn" as const) : ("pass" as const),
          message: s.emptyAlt ? "Empty alt on a linked image" : "No empty alt",
          pageUrl: url(s.i),
        },
      ]),
    },
    "perf/ttfb": {
      meta: meta("perf/ttfb", "perf", "page", "warning", 6),
      checks: rows((s) => ({
        name: "ttfb",
        status: s.ttfb === "slow" ? "warn" : s.ttfb === "skipped" ? "skipped" : "pass",
        message: s.ttfb === "slow" ? "Slow TTFB" : s.ttfb === "skipped" ? "No timing data" : "TTFB ok",
        pageUrl: url(s.i),
      })),
    },
    "content/readability": {
      meta: meta("content/readability", "content", "page", "info", 3),
      checks: rows((s) => ({
        name: "readability",
        status: s.readability ? "warn" : "pass",
        message: s.readability ? "Hard to read" : "Readable",
        pageUrl: url(s.i),
      })),
    },
    "content/word-count": {
      meta: meta("content/word-count", "content", "page", "warning", 4),
      checks: rows((s) => ({
        name: "word-count",
        status: "info",
        message: "Word count recorded",
        pageUrl: url(s.i),
      })),
    },
    [RULE_ID_ROBOTS_TXT]: {
      meta: meta(RULE_ID_ROBOTS_TXT, "crawl", "site", "error", 9),
      checks: [
        {
          name: CHECK_NAME_ROBOTS_EXISTS,
          status: opts.robotsMissing ? "fail" : "pass",
          message: opts.robotsMissing ? "robots.txt missing" : "robots.txt found",
        },
        { name: CHECK_NAME_ROBOTS_DISALLOW, status: "pass", message: "Not blocking all" },
      ],
    },
    [RULE_ID_SITEMAP_EXISTS]: {
      meta: meta(RULE_ID_SITEMAP_EXISTS, "crawl", "site", "warning", 5),
      checks: [{ name: CHECK_NAME_SITEMAP_EXISTS, status: "pass", message: "Sitemap found" }],
    },
  };
  return {
    baseUrl: `${SITE}/`,
    ruleResults,
    pages: shapes.map((s) => ({ url: url(s.i), statusCode: s.status ?? 200 })),
  };
}

/** Today's uncapped body: every row, the non-2xx statuses, the unsampled signal. */
function uncappedBody(report: ReturnType<typeof fullReport>) {
  return {
    ruleResults: report.ruleResults,
    pageStatuses: report.pages
      .filter((p) => p.statusCode < 200 || p.statusCode >= 300)
      .map((p) => ({ url: p.url, status: p.statusCode })),
    resolutionSignal: buildResolutionSignal(
      report.ruleResults,
      report.pages.map((p) => p.url),
    ),
  };
}

/** The capped body the CLI and the container publish after repo#2656. */
function cappedBody(report: ReturnType<typeof fullReport>) {
  const capped = capReportForPublish(report);
  return {
    ruleResults: capped.ruleResults as unknown as Rules,
    pageStatuses: capped.pageStatuses ?? [],
    resolutionSignal: capped.resolutionSignal,
    checkTallies: capped.checkTallies,
  };
}

/** What the API stores after the rescore: the score and the report's totals. */
function rescored(r: CloudSmartAuditsResult): {
  healthScore: HealthScore;
  totals: { passed: number; warnings: number; failed: number };
} {
  if (r.scoringTallies) {
    return {
      healthScore: calculateHealthScoreFromTallies(r.scoringTallies, r.unionRuleResults),
      totals: r.reportTotals!,
    };
  }
  // apps/api applyUnionToReport, sampled path: count the union's own checks.
  const totals = { passed: 0, warnings: 0, failed: 0 };
  for (const rule of r.unionRuleResults.values()) {
    const advisory = rule.meta.severity === "info";
    for (const c of rule.checks) {
      if (c.status === "pass") totals.passed++;
      else if (c.status === "warn" && !advisory) totals.warnings++;
      else if (c.status === "fail") totals.failed++;
    }
  }
  return { healthScore: calculateHealthScore({ results: r.unionRuleResults }), totals };
}

/**
 * Category order among equal (failed, warnings, score) categories follows rule
 * order, which the capper canonicalizes; every value is compared, the tie order
 * is not.
 */
function comparable(s: ReturnType<typeof rescored>) {
  return {
    ...s,
    healthScore: {
      ...s.healthScore,
      categories: [...s.healthScore.categories].sort((a, b) =>
        a.category < b.category ? -1 : a.category > b.category ? 1 : 0,
      ),
    },
  };
}

type Body = ReturnType<typeof uncappedBody> | ReturnType<typeof cappedBody>;

function publish(store: MemStore, crawlId: string, body: Body, now: number) {
  return runCloudSmartAudits({ store, siteKey: "site", crawlId, now, ...body });
}

/** Publishes the same audit uncapped and capped to two copies of `seed`. */
async function bothWays(seed: MemStore, crawlId: string, report: ReturnType<typeof fullReport>) {
  const now = 1_780_000_000_000;
  const uncappedStore = seed.clone();
  const cappedStore = seed.clone();
  const capped = cappedBody(report);
  const uncapped = await publish(uncappedStore, crawlId, uncappedBody(report), now);
  const cappedResult = await publish(cappedStore, crawlId, capped, now);
  return { uncapped, capped: cappedResult, cappedStore, uncappedStore, cappedBody: capped };
}

/** 60 pages, every kind of check: issue classes wider than the 10-page sample. */
function busyShapes(pages: number[]): PageShape[] {
  return pages.map((i) => ({
    i,
    metaMissing: i % 3 === 0,
    altItems: i % 4 === 0 ? 3 : i % 7 === 0 ? 12 : 0,
    extra: i % 8 === 0 ? 40 : 0,
    emptyAlt: i % 5 === 0,
    ttfb: i % 6 === 0 ? "slow" : i % 11 === 0 ? "skipped" : undefined,
    readability: i % 2 === 0,
  }));
}

async function seeded(report: ReturnType<typeof fullReport>): Promise<MemStore> {
  const store = new MemStore();
  await publish(store, "audit_1", uncappedBody(report), 1_779_000_000_000);
  return store;
}

const openUrls = async (store: MemStore, ruleId: string, checkName: string): Promise<Set<string>> =>
  new Set(
    (await store.getFindings("site", ["open"]))
      .filter((f) => f.ruleId === ruleId && f.checkName === checkName)
      .map((f) => f.normalizedUrl),
  );

describe("rescore of a capped report (repo#2657)", () => {
  test("first audit: the capped body scores exactly as the uncapped one", async () => {
    const report = fullReport(busyShapes(range(0, 60)), { robotsMissing: true });
    const { uncapped, capped, cappedBody: body } = await bothWays(new MemStore(), "audit_1", report);

    // The body really is capped: no pass rows, at most 10 pages per class.
    for (const rule of Object.values(body.ruleResults)) {
      for (const c of rule.checks) {
        if (c.pageUrl || c.details?.aggregated) expect(c.status).not.toBe("pass");
        expect(c.pages?.length ?? 0).toBeLessThanOrEqual(10);
      }
    }
    expect(capped.scoringTallies).toBeDefined();
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    expect(rescored(capped).healthScore.overall).toBeLessThan(100);
    expect(capped.coverage).toEqual(uncapped.coverage);
  });

  test("no page findings at all: the capped body scores as the uncapped one", async () => {
    const report = fullReport(range(0, 40).map((i) => ({ i })));
    const { uncapped, capped } = await bothWays(new MemStore(), "audit_1", report);
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    expect(rescored(capped).totals.passed).toBeGreaterThan(0);
    expect(capped.coverage).toEqual(uncapped.coverage);
  });

  test("partial re-audit with open findings: same score, crawled-clean resolves, uncrawled carries", async () => {
    const seed = await seeded(fullReport(busyShapes(range(0, 60))));

    // Run 2 crawls pages 0-39 only. Meta descriptions are fixed on 0-19, a page
    // newly fails on 20-29, page 30 is now 404, and ttfb is skipped on 31-33.
    const shapes = busyShapes(range(0, 40)).map((s) => ({
      ...s,
      metaMissing: s.i >= 20 && s.i < 30 ? true : s.i < 20 ? false : s.metaMissing,
      status: s.i === 30 ? 404 : undefined,
      ttfb: s.i >= 31 && s.i <= 33 ? ("skipped" as const) : s.ttfb,
    }));
    const { uncapped, capped, cappedStore } = await bothWays(seed, "audit_2", fullReport(shapes));

    expect(capped.coverage.carriedFindings).toBeGreaterThan(0);
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    // The coverage line counts what the report shows as carried: not the
    // still-failing pages the sample clipped, which the tallies already count.
    expect(capped.coverage).toEqual(uncapped.coverage);

    const open = await openUrls(cappedStore, "core/meta-description", "has-meta-description");
    // Crawled clean this run: resolved, though most of them were never in a sample.
    for (const i of range(0, 20)) expect(open.has(url(i))).toBe(false);
    // Not crawled this run: carried.
    for (const i of range(40, 60).filter((i) => i % 3 === 0)) expect(open.has(url(i))).toBe(true);
    // Failing this run, in the 10-page sample (20-29) or clipped from it (33,
    // 36, 39 failed in both runs): open, not resolved.
    for (const i of [...range(20, 30), 33, 36, 39]) expect(open.has(url(i))).toBe(true);
    // Gone (404): staled.
    expect(open.has(url(30))).toBe(false);
    // Only what the union shows as carried is tagged carried: the clipped pages
    // are counted by the tallies, the uncrawled ones are carried.
    const tagged = (i: number) =>
      capped.carriedLastSeen.has(`${url(i)}|core/meta-description|has-meta-description`);
    for (const i of [33, 36, 39]) expect(tagged(i)).toBe(false);
    for (const i of range(40, 60).filter((i) => i % 3 === 0)) expect(tagged(i)).toBe(true);
  });

  test("a check skipped on a page keeps that page's finding open, and the score still matches", async () => {
    const seed = await seeded(
      fullReport(range(0, 30).map((i) => ({ i, ttfb: "slow" as const }))),
    );
    // Run 2: ttfb is fine on 0-19 and has no timing data on 20-29.
    const shapes = range(0, 30).map((i) => ({
      i,
      ttfb: i >= 20 ? ("skipped" as const) : undefined,
    }));
    const { uncapped, capped, cappedStore } = await bothWays(seed, "audit_2", fullReport(shapes));
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    const open = await openUrls(cappedStore, "perf/ttfb", "ttfb");
    expect(open).toEqual(new Set(range(20, 30).map(url)));
  });

  test("a crawled page no check evaluated earns no synthetic pass from its carried finding", async () => {
    // Page 10's ttfb warning is open. Run 2 crawls all 11 pages but every check
    // skips every page, so the capped sample (10 pages per class) leaves page 10
    // out of the payload: it must still not read as an uncrawled clean page.
    const seed = await seeded(
      fullReport(range(0, 11).map((i) => ({ i, ttfb: i === 10 ? ("slow" as const) : undefined }))),
    );
    const skipped = (name: string, i: number): CheckResult => ({
      name,
      status: "skipped",
      message: "Not evaluated",
      pageUrl: url(i),
      skipReason: SCAN_TRUNCATED_SKIP_REASON,
      details: { foldKey: SCAN_TRUNCATED_SKIP_REASON },
    });
    const base = fullReport(range(0, 11).map((i) => ({ i })));
    const run2 = {
      ...base,
      ruleResults: {
        "perf/ttfb": {
          meta: base.ruleResults["perf/ttfb"]!.meta,
          checks: range(0, 11).map((i) => skipped("ttfb", i)),
        },
        "core/meta-description": {
          meta: base.ruleResults["core/meta-description"]!.meta,
          checks: range(0, 11).map((i) => skipped("has-meta-description", i)),
        },
      },
    };
    const { uncapped, capped } = await bothWays(seed, "audit_2", run2);
    expect(capped.coverage.carriedFindings).toBe(1);
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
  });

  test("a carry the merge keeps on a page the tallies count adds nothing to the score", async () => {
    // `/p` and `/p?id=1` are two pages. `/p?id=1` fails the item check in both
    // runs with different items; `/p` is crawled but not evaluated. The merge
    // carries the old item on `/p?id=1` (its query-blind hash is `/p`'s, which is
    // listed not evaluated), but the tallies already count `/p?id=1`.
    const P = `${SITE}/p`;
    const Q = `${SITE}/p?id=1`;
    const audit = (items: string[]) => {
      const base = fullReport([{ i: 0 }]);
      return {
        ...base,
        pages: [P, Q].map((u) => ({ url: u, statusCode: 200 })),
        ruleResults: {
          "a11y/img-alt": {
            meta: base.ruleResults["a11y/img-alt"]!.meta,
            checks: [
              { name: "img-alt", status: "skipped" as const, message: "n/a", pageUrl: P },
              {
                name: "img-alt",
                status: "fail" as const,
                message: "Images missing alt",
                pageUrl: Q,
                items: items.map((id) => ({ id, sourcePages: [Q] })),
              },
            ],
          },
        },
      };
    };
    const seed = await seeded(audit(["a.png", "b.png"]));
    const run2 = audit(["b.png", "c.png"]);
    const { capped } = await bothWays(seed, "audit_2", run2);
    const first = await bothWays(new MemStore(), "audit_2", run2);
    expect(rescored(capped)).toEqual(rescored(first.capped));
    // Nor does it tag the fresh check on that page as carried.
    expect(capped.coverage.carriedFindings).toBe(0);
    expect(capped.carriedLastSeen.size).toBe(0);
  });

  test("a report without tallies (an older producer) keeps the row-counting path", async () => {
    const report = fullReport(busyShapes(range(0, 20)));
    const r = await publish(new MemStore(), "audit_1", uncappedBody(report), 1);
    expect(r.scoringTallies).toBeUndefined();
    expect(r.reportTotals).toBeUndefined();
  });
});

describe("buildCheckTallies leaves out what the rescore leaves out (repo#2657)", () => {
  test("checks on a 404/410 page are not counted", () => {
    const report = fullReport(
      range(0, 12).map((i) => ({ i, metaMissing: true, status: i === 3 ? 404 : i === 4 ? 410 : undefined })),
    );
    const capped = capReportForPublish(report);
    expect(capped.checkTallies["core/meta-description"]).toEqual({
      "has-meta-description": { failed: 10, failUnits: 10 },
    });
    expect(buildCheckTallies(report.ruleResults)["core/meta-description"]).toEqual({
      "has-meta-description": { failed: 12, failUnits: 12 },
    });
  });

  test("a producer's page replays are not counted; a site check tagged carried is", () => {
    const tallies = buildCheckTallies({
      "core/meta-description": {
        meta: { severity: "warning" },
        checks: [
          { name: "m", status: "fail", message: "x", pageUrl: url(1) },
          { name: "m", status: "fail", message: "x", pageUrl: url(2), provenance: "carried" },
          { name: "m", status: "fail", message: "x", pageUrl: url(3), provenance: "unrendered" },
          { name: "site", status: "warn", message: "y", provenance: "carried" },
        ],
      },
    });
    expect(tallies["core/meta-description"]).toEqual({
      m: { failed: 1, failUnits: 1 },
      site: { warnings: 1, warnUnits: 1 },
    });
  });
});
