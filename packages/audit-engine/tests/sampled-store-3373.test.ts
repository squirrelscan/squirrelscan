// squirrelscan/repo#3373: a partial re-audit over a SAMPLED cloud store.
//
// A capped report published as one POST (the CLI's publish) leaves the store a
// 10-page sample of each issue class. Every test publishes the same first audit
// twice, once capped (the sampled store) and once uncapped (the full store a
// chunked publish would leave), then re-audits part of the site against both.
// The sampled store is told it is sampled and given the first audit's tallies
// (`sampledStore`); the full store is not. The sampled store's score must never
// be higher than the full store's, and must equal it when the re-audit re-checks
// none of the first audit's pages, or all of them.

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  CheckTallies,
  FindingState,
  HealthScore,
  PageFindingRecord,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import {
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
  ISSUE_PENALTY_ITEM_CAP,
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
} from "@squirrelscan/utils/constants";

import {
  aggregateUntouchedCarried,
  carriedChecksPerPageFor,
  isAggregatableCarriedRow,
  type UntouchedCarriedPage,
} from "../src/complete-store-fold";
import { findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type CompleteStoreScope,
  type CloudSmartAuditsInput,
  type CloudSmartAuditsResult,
  type SmartAuditStore,
} from "../src/merge-promise";
import { capReportForPublish } from "../src/publish-cap";
import type { SampledStoreMarker } from "../src/sampled-store";
import {
  calculateHealthScore,
  calculateHealthScoreFromTallies,
  foldRuleResultIntoTallies,
  isCarriedContinuation,
  type RuleTally,
} from "../src/scoring";
import { buildStreamFindings } from "../src/stream-findings";
import { describeSitePagesContract } from "./helpers/site-pages-contract";

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

interface PageShape {
  i: number;
  status?: number;
  metaMissing?: boolean;
  /** img-alt fail items (at most 12, as rules truncate their lists). */
  altItems?: number;
  emptyAlt?: boolean;
  ttfb?: "slow" | "skipped";
  readability?: boolean;
  /**
   * x/tri: a rule with three check names on some pages and two on others, so
   * its rounded checks per page is below what some pages hold. The rule is only
   * in the report when a shape sets this (true fails every check, false passes).
   */
  tri?: boolean;
}

/** A full per-page report: every page rule emits one row per page and check name. */
function fullReport(shapes: PageShape[]) {
  const rows = (fn: (s: PageShape) => CheckResult | CheckResult[]): CheckResult[] =>
    shapes.flatMap((s) => fn(s));
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
              message: `${s.altItems} images missing alt`,
              pageUrl: url(s.i),
              items: range(0, s.altItems).map((k) => ({
                id: `${SITE}/img/${s.i}-${k}.png`,
                sourcePages: [url(s.i)],
              })),
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
    ...(shapes.some((s) => s.tri !== undefined)
      ? {
          "x/tri": {
            meta: meta("x/tri", "core", "page", "error", 5),
            checks: rows((s) => {
              const status = s.tri ? ("fail" as const) : ("pass" as const);
              const out: CheckResult[] = [
                { name: "a", status, message: "a", pageUrl: url(s.i) },
                { name: "b", status, message: "b", pageUrl: url(s.i) },
              ];
              if (s.i % 5 < 2) out.push({ name: "c", status, message: "c", pageUrl: url(s.i) });
              return out;
            }),
          },
        }
      : {}),
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
    [RULE_ID_ROBOTS_TXT]: {
      meta: meta(RULE_ID_ROBOTS_TXT, "crawl", "site", "error", 9),
      checks: [
        { name: CHECK_NAME_ROBOTS_EXISTS, status: "pass", message: "robots.txt found" },
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
type Report = ReturnType<typeof fullReport>;

/** The uncapped body: every row, the non-2xx statuses, the unsampled signal. */
function uncappedBody(report: Report) {
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

/** The capped body a CLI publishes as one POST, plus what it reports beside it. */
async function cappedBody(report: Report) {
  const capped = capReportForPublish(report);
  return {
    body: {
      ruleResults: capped.ruleResults as unknown as Rules,
      pageStatuses: capped.pageStatuses ?? [],
      resolutionSignal: capped.resolutionSignalCompact
        ? await decodeResolutionSignal(capped.resolutionSignalCompact)
        : undefined,
      checkTallies: capped.checkTallies,
    },
    rulePageCounts: capped.rulePageCounts,
  };
}

/**
 * The score and the report's totals after the rescore, in check units (repo#3360).
 * On the scoringTallies path this is what the API stores. On the no-tallies path
 * it is what the API WILL store once the private applyUnionToReport follow-up
 * skips carried continuation rows too; until then the API's stored totals count
 * those rows and can differ from these.
 */
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
  const totals = { passed: 0, warnings: 0, failed: 0 };
  for (const rule of r.unionRuleResults.values()) {
    const advisory = rule.meta.severity === "info";
    for (const c of rule.checks) {
      // (repo#3360) A carried item row after the first of its (page, check, status)
      // is no extra check, as the engine's reportTotals skip it (the API's
      // applyUnionToReport loop follows in the private follow-up).
      if (isCarriedContinuation(c)) continue;
      if (c.status === "pass") totals.passed++;
      else if (c.status === "warn" && !advisory) totals.warnings++;
      else if (c.status === "fail") totals.failed++;
    }
  }
  return { healthScore: calculateHealthScore({ results: r.unionRuleResults }), totals };
}

/** Category order among ties follows rule order; compare the values, not the order. */
function comparable(s: ReturnType<typeof rescored>) {
  const byCategory = <T extends { category: string }>(list: T[]) =>
    [...list].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { ...s, healthScore: { ...s.healthScore, categories: byCategory(s.healthScore.categories) } };
}

/** The per-rule tallies a result is scored from. */
function tallies(r: CloudSmartAuditsResult): Map<string, RuleTally> {
  if (r.scoringTallies) return r.scoringTallies;
  const out = new Map<string, RuleTally>();
  for (const [ruleId, rule] of r.unionRuleResults) foldRuleResultIntoTallies(out, ruleId, rule);
  return out;
}

const FIRST = 1_779_000_000_000;
const SECOND = 1_780_000_000_000;

interface Seeded {
  full: MemStore;
  sampled: MemStore;
  marker: SampledStoreMarker;
  /** The CLI audit's own score, as the capped publish scored it. */
  cliScore: number;
  /** Pages of each rule the sampled store holds a row for. */
  sampledPages: Map<string, Set<string>>;
}

/** The first audit, published capped to one store and uncapped to another. */
async function seed(
  shapes: PageShape[],
  markerOverrides: Partial<SampledStoreMarker> = {},
  older: PageShape[] = [],
): Promise<Seeded> {
  const report = fullReport(shapes);
  const full = new MemStore();
  const sampled = new MemStore();
  // An earlier complete audit of other pages, in both stores alike.
  if (older.length > 0) {
    for (const store of [full, sampled]) {
      await runCloudSmartAudits({
        store,
        siteKey: "site",
        crawlId: "cloud_0",
        now: FIRST - 1_000_000,
        ...uncappedBody(fullReport(older)),
      });
    }
  }
  await runCloudSmartAudits({ store: full, siteKey: "site", crawlId: "cli_1", now: FIRST, ...uncappedBody(report) });
  const { body, rulePageCounts } = await cappedBody(report);
  const first = await runCloudSmartAudits({ store: sampled, siteKey: "site", crawlId: "cli_1", now: FIRST, ...body });
  const sampledPages = new Map<string, Set<string>>();
  for (const f of await sampled.getFindings("site", ["open"])) {
    let set = sampledPages.get(f.ruleId);
    if (!set) {
      set = new Set();
      sampledPages.set(f.ruleId, set);
    }
    set.add(f.normalizedUrl);
  }
  return {
    full,
    sampled,
    sampledPages,
    cliScore: rescored(first).healthScore.overall!,
    marker: {
      sampled: true,
      crawlId: "cli_1",
      checkTallies: body.checkTallies,
      pagesAudited: shapes.length,
      ...(rulePageCounts ? { rulePageCounts } : {}),
      ...markerOverrides,
    },
  };
}

/** Re-audit `shapes` against the seeded stores, uncapped (a small cloud run). */
async function reaudit(s: Seeded, shapes: PageShape[], opts: { capped?: boolean } = {}) {
  const report = fullReport(shapes);
  const body = opts.capped ? (await cappedBody(report)).body : uncappedBody(report);
  const full = await runCloudSmartAudits({ store: s.full, siteKey: "site", crawlId: "cloud_2", now: SECOND, ...body });
  const estimated = await runCloudSmartAudits({
    store: s.sampled,
    siteKey: "site",
    crawlId: "cloud_2",
    now: SECOND,
    ...body,
    sampledStore: s.marker,
  });
  return { full, estimated };
}

/** A site with every kind of class, wider than the 10-page sample. */
function busyShapes(pages: number[]): PageShape[] {
  return pages.map((i) => ({
    i,
    metaMissing: i % 3 === 0,
    altItems: i % 4 === 0 ? 3 : i % 7 === 0 ? 12 : 0,
    emptyAlt: i % 5 === 0,
    ttfb: i % 6 === 0 ? "slow" : i % 11 === 0 ? "skipped" : undefined,
    readability: i % 2 === 0,
  }));
}

/** Deterministic PRNG (mulberry32), so a failing case can be replayed. */
function prng(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomShapes(rand: () => number, pages: number[]): PageShape[] {
  return pages.map((i) => ({
    i,
    metaMissing: rand() < 0.45,
    altItems: rand() < 0.3 ? 1 + Math.floor(rand() * 12) : 0,
    emptyAlt: rand() < 0.35,
    ttfb: rand() < 0.3 ? "slow" : rand() < 0.1 ? "skipped" : undefined,
    readability: rand() < 0.5,
  }));
}

describe("partial re-audit over a sampled store (repo#3373)", () => {
  test("the issue: a 1-page cloud re-audit after a 100-page CLI publish scores within 2 points", async () => {
    // A check fails on every page; the CLI publish leaves 10 of them in the store.
    const shapes = range(0, 100).map((i) => ({ i, metaMissing: true }));
    const s = await seed(shapes);
    expect(s.sampledPages.get("core/meta-description")!.size).toBeLessThanOrEqual(10);

    const rerun = [shapes[0]!];
    // Without the marker the store's 90 clipped pages read clean.
    const unmarked = await runCloudSmartAudits({
      store: structuredCloneStore(s.sampled),
      siteKey: "site",
      crawlId: "cloud_2",
      now: SECOND,
      ...uncappedBody(fullReport(rerun)),
    });
    expect(rescored(unmarked).healthScore.overall!).toBeGreaterThan(s.cliScore + 2);

    const { full, estimated } = await reaudit(s, rerun);
    const score = rescored(estimated).healthScore.overall!;
    expect(estimated.sampledStoreScored).toBe(true);
    expect(Math.abs(score - s.cliScore)).toBeLessThanOrEqual(2);
    expect(score).toBeLessThanOrEqual(rescored(full).healthScore.overall!);
  }, 30_000);

  test("no overlap: sampled store plus tallies scores exactly as the full store", async () => {
    const shapes = range(0, 100).map((i) => ({ i, metaMissing: i % 2 === 0 }));
    const s = await seed(shapes);
    // A page the first audit never saw.
    const { full, estimated } = await reaudit(s, [{ i: 100, metaMissing: true }]);
    expect(comparable(rescored(estimated))).toEqual(comparable(rescored(full)));
  }, 30_000);

  test("parity fixture: every kind of class, published complete or sampled, scores the same with no overlap", async () => {
    const s = await seed(busyShapes(range(0, 60)));
    // The capped publish really sampled the store.
    expect(s.sampledPages.get("core/meta-description")!.size).toBeLessThan(20);
    const { full, estimated } = await reaudit(s, busyShapes([60, 61]));
    expect(comparable(rescored(estimated))).toEqual(comparable(rescored(full)));
    expect(rescored(estimated).healthScore.overall!).toBeLessThan(100);
  }, 30_000);

  test("no overlap, with an older audit's pages beside the sample: their rows count as they are", async () => {
    // Pages 200-229 come from an earlier complete cloud audit and are no part of
    // the CLI audit's tallies; their carried warnings stay warnings.
    const older = busyShapes(range(200, 230)).map((sh) => ({ ...sh, ttfb: "slow" as const }));
    const s = await seed(busyShapes(range(0, 60)), {}, older);
    const { full, estimated } = await reaudit(s, busyShapes([60]));
    expect(comparable(rescored(estimated))).toEqual(comparable(rescored(full)));
  }, 30_000);

  test("full overlap: re-checking every page scores as a fresh full audit", async () => {
    const shapes = busyShapes(range(0, 60));
    const s = await seed(shapes);
    const { full, estimated } = await reaudit(s, shapes);
    const fresh = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "site",
      crawlId: "cloud_2",
      now: SECOND,
      ...uncappedBody(fullReport(shapes)),
    });
    expect(comparable(rescored(estimated))).toEqual(comparable(rescored(fresh)));
    expect(comparable(rescored(full))).toEqual(comparable(rescored(fresh)));
  }, 30_000);

  test("partial overlap: never above the full store, and within the documented bound", async () => {
    const rand = prng(3373);
    let below = 0;
    for (let round = 0; round < 24; round++) {
      const pages = 25 + Math.floor(rand() * 50);
      const shapes = randomShapes(rand, range(0, pages));
      const s = await seed(shapes);
      // Re-audit a random part of the site (some rounds capped, as a big run
      // publishes), with a new page now and then and some pages changed or gone.
      const rerun: PageShape[] = [];
      for (const shape of shapes) {
        if (rand() >= 0.35) continue;
        const roll = rand();
        rerun.push(
          roll < 0.1
            ? { ...shape, status: 404 }
            : roll < 0.25
              ? { ...shape, metaMissing: !shape.metaMissing, ttfb: rand() < 0.5 ? "skipped" : shape.ttfb }
              : shape,
        );
      }
      if (rand() < 0.3) rerun.push(...randomShapes(rand, [pages]));
      const { full, estimated } = await reaudit(s, rerun, { capped: rand() < 0.3 });

      const est = rescored(estimated).healthScore;
      const ref = rescored(full).healthScore;
      const label = `round ${round}: ${pages} pages, ${rerun.length} re-audited`;
      expect({ label, ok: est.overall! <= ref.overall! }).toEqual({ label, ok: true });
      for (const c of est.categories) {
        const refScore = ref.categories.find((r) => r.category === c.category)?.score ?? 100;
        expect({ label, category: c.category, ok: c.score <= refScore }).toEqual({
          label,
          category: c.category,
          ok: true,
        });
      }
      if (est.overall! < ref.overall!) below += 1;

      // The bound: per rule, the estimate carries at most the unknown re-checked
      // pages' worth of extra issues (each check name, up to the item cap) and
      // that many fewer clean carried pages.
      const rechecked = new Set(rerun.filter((r) => r.i < pages).map((r) => url(r.i)));
      const estTallies = tallies(estimated);
      for (const [ruleId, { tally: refTally, meta: m }] of tallies(full)) {
        if (m.scope !== "page") continue;
        const estTally = estTallies.get(ruleId)!.tally;
        const sampled = s.sampledPages.get(ruleId) ?? new Set<string>();
        const unknown = [...rechecked].filter((u) => !sampled.has(u)).length;
        const names = Object.keys(s.marker.checkTallies[ruleId] ?? {}).length;
        const issues = (t: typeof refTally) => t.failed + t.warnings;
        expect({ label, ruleId, ok: issues(estTally) - issues(refTally) <= unknown * names * ISSUE_PENALTY_ITEM_CAP }).toEqual({
          label,
          ruleId,
          ok: true,
        });
        expect({ label, ruleId, ok: refTally.passed - estTally.passed <= unknown }).toEqual({
          label,
          ruleId,
          ok: true,
        });
      }
    }
    // The property is not vacuous: the bias does show on some rounds.
    expect(below).toBeGreaterThan(0);
  }, 120_000);

  test("flag absent or not sampled: the result is exactly the unmarked one", async () => {
    const shapes = busyShapes(range(0, 60));
    const report = fullReport(range(0, 20).map((i) => shapes[i]!));
    const results: CloudSmartAuditsResult[] = [];
    for (const sampledStore of [undefined, { ...(await seed(shapes)).marker, sampled: false }]) {
      const s = await seed(shapes);
      results.push(
        await runCloudSmartAudits({
          store: s.sampled,
          siteKey: "site",
          crawlId: "cloud_2",
          now: SECOND,
          ...uncappedBody(report),
          ...(sampledStore ? { sampledStore } : {}),
        }),
      );
    }
    expect(results[1]).toEqual(results[0]!);
    expect(results[0]!.scoringTallies).toBeUndefined();
    expect(results[0]!.sampledStoreScored).toBeUndefined();
  }, 30_000);

  test("a re-crawled sampled-dirty page that did not evaluate the check is no carried pass page (#3360 review)", async () => {
    // img-alt fails on 15 of 20 pages, 3 items each. The re-audit crawls 3 pages
    // the sample holds an img-alt row for, with img-alt left out (as under a
    // truncated signal key, where evaluated() is false everywhere), plus 1 new
    // page that runs it. No page is unknown, so the estimate equals the full store.
    const shapes: PageShape[] = range(0, 20).map((i) => ({ i, altItems: i < 15 ? 3 : 0 }));
    const s = await seed(shapes);
    const sampled = s.sampledPages.get("a11y/img-alt") ?? new Set<string>();
    const recrawled = shapes.filter((sh) => sampled.has(url(sh.i))).slice(0, 3);
    expect(recrawled).toHaveLength(3);
    const report = fullReport([...recrawled, { i: 20 }]);
    report.ruleResults["a11y/img-alt"]!.checks = report.ruleResults["a11y/img-alt"]!.checks.filter(
      (c) => c.pageUrl === url(20),
    );
    const body = uncappedBody(report);
    const full = await runCloudSmartAudits({ store: s.full, siteKey: "site", crawlId: "cloud_2", now: SECOND, ...body });
    const estimated = await runCloudSmartAudits({
      store: s.sampled,
      siteKey: "site",
      crawlId: "cloud_2",
      now: SECOND,
      ...body,
      sampledStore: s.marker,
    });
    expect(tallies(full).get("a11y/img-alt")!.tally).toMatchObject({ failed: 15, failUnits: 45, passed: 24 });
    expect(tallies(estimated).get("a11y/img-alt")!.tally).toEqual(tallies(full).get("a11y/img-alt")!.tally);
    expect(comparable(rescored(estimated))).toEqual(comparable(rescored(full)));
  }, 30_000);

  test("K > 1 pass delta never takes fresh passes: 3-name rule, rounded K of 2 (#3360 review)", async () => {
    // Every x/tri check fails on 60 pages (3 names on 24 of them, 2 on the rest,
    // so K rounds to 2); the re-audit adds 20 new clean pages.
    const shapes: PageShape[] = range(0, 60).map((i) => ({ i, tri: true }));
    const s = await seed(shapes);
    const rerun: PageShape[] = range(60, 80).map((i) => ({ i, tri: false }));
    const { full, estimated } = await reaudit(s, rerun);
    const truth = await runCloudSmartAudits({
      store: new MemStore(),
      siteKey: "site",
      crawlId: "fresh",
      now: SECOND,
      ...uncappedBody(fullReport([...shapes, ...rerun])),
    });
    expect(tallies(truth).get("x/tri")!.tally).toMatchObject({ failed: 144, passed: 48 });
    expect(tallies(estimated).get("x/tri")!.tally).toMatchObject({ failed: 144, passed: 48 });
    expect(tallies(estimated).get("x/tri")!.tally).toEqual(tallies(full).get("x/tri")!.tally);
  }, 30_000);

  test("without pagesAudited every estimated warning scores as a failure, never higher", async () => {
    const shapes = busyShapes(range(0, 60));
    const withCount = await seed(shapes);
    const without = await seed(shapes, { pagesAudited: undefined });
    const rerun = busyShapes([60]);
    const a = await reaudit(withCount, rerun);
    const b = await reaudit(without, rerun);
    expect(rescored(b.estimated).healthScore.overall!).toBeLessThanOrEqual(
      rescored(a.estimated).healthScore.overall!,
    );
    expect(rescored(b.estimated).totals.warnings).toBeLessThan(rescored(a.estimated).totals.warnings);
  }, 30_000);
});

// ── repo#4626: the same partial re-audit, published chunked ──────────────────

const DRIVERS = ["cursor", "arrays", "split"] as const;
type Driver = (typeof DRIVERS)[number];

/** The store's open rows, one page at a time in primary-key order. */
async function openRowsByPage(store: MemStore): Promise<Array<[string, PageFindingRecord[]]>> {
  const rows = (await store.getFindings("site", ["open"])).sort((a, b) => {
    const ka = findingKey(a.normalizedUrl, a.ruleId, a.checkName, a.locator);
    const kb = findingKey(b.normalizedUrl, b.ruleId, b.checkName, b.locator);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const byPage = new Map<string, PageFindingRecord[]>();
  for (const f of rows) {
    const list = byPage.get(f.normalizedUrl);
    if (list) list.push(f);
    else byPage.set(f.normalizedUrl, [f]);
  }
  return [...byPage];
}

/**
 * The container's chunked publish of `shapes`: the full report's findings stream
 * into `store` first, then the finalize merges the capped shell, reading the store
 * as `driver` says (`cursor`: one cursor; `arrays`: this run's rows beside the
 * earlier ones; `split`: touched pages plus an untouched aggregate, the API's default).
 */
async function reauditChunked(
  store: MemStore,
  shapes: PageShape[],
  driver: Driver,
  sampledStore?: SampledStoreMarker,
) {
  const report = fullReport(shapes);
  const { body } = await cappedBody(report);
  const crawlId = "cloud_2";
  await store.upsertFindings(
    buildStreamFindings(report.ruleResults, SECOND).map((line) => ({
      ...line,
      siteKey: "site",
      lastSeenCrawlId: crawlId,
    })),
  );
  const pages = await openRowsByPage(store);
  const fresh = (rows: PageFindingRecord[]) => rows.filter((f) => f.lastSeenCrawlId === crawlId);
  const prior = (rows: PageFindingRecord[]) => rows.filter((f) => f.lastSeenCrawlId !== crawlId);
  const openPage = (normalizedUrl: string, rows: PageFindingRecord[]) => ({
    normalizedUrl,
    fresh: fresh(rows),
    prior: prior(rows),
  });
  async function* openPages() {
    for (const [normalizedUrl, rows] of pages) yield openPage(normalizedUrl, rows);
  }
  async function* findingPages() {
    for (const [, rows] of pages) if (fresh(rows).length > 0) yield fresh(rows);
  }
  const untouchedCarried = async (scope: CompleteStoreScope) => {
    const isTouched = (u: string, rows: PageFindingRecord[]) =>
      scope.crawledUrls.has(u) || scope.removedUrls.has(u) || fresh(rows).length > 0;
    const untouched: UntouchedCarriedPage[] = [];
    for (const [u, rows] of pages) {
      if (isTouched(u, rows)) continue;
      expect(rows.every(isAggregatableCarriedRow)).toBe(true);
      const page = store.pages.get(u);
      untouched.push({ normalizedUrl: u, rows, rendered: !!page, active: page?.state === "active" });
    }
    const { aggregate, sample } = aggregateUntouchedCarried(untouched);
    const sampleByUrl = new Map(sample.map((p) => [p.normalizedUrl, p]));
    async function* merged() {
      for (const [u, rows] of pages) {
        if (isTouched(u, rows)) yield openPage(u, rows);
        else if (sampleByUrl.has(u)) yield sampleByUrl.get(u)!;
      }
    }
    return { pages: merged(), aggregate };
  };
  const crawledUrls = body.resolutionSignal!.crawledUrls;
  return runCloudSmartAudits({
    store,
    siteKey: "site",
    crawlId,
    now: SECOND,
    ruleResults: body.ruleResults,
    pageStatuses: body.pageStatuses,
    resolutionSignal: body.resolutionSignal,
    checkTallies: body.checkTallies,
    ...(sampledStore ? { sampledStore } : {}),
    completeStore:
      driver === "arrays"
        ? {
            findingPages: findingPages(),
            priorOpenFindings: pages.flatMap(([, rows]) => prior(rows)),
            crawledUrls,
          }
        : driver === "split"
          ? { untouchedCarried, crawledUrls }
          : { openPages: openPages(), crawledUrls },
  });
}

describe("chunked partial re-audit over a sampled store (repo#4626)", () => {
  for (const driver of DRIVERS) {
    test(`${driver}: no overlap scores exactly as the full store`, async () => {
      const s = await seed(busyShapes(range(0, 60)));
      expect(s.sampledPages.get("core/meta-description")!.size).toBeLessThan(20);
      const rerun = busyShapes([60, 61]);
      const full = await reauditChunked(s.full, rerun, driver);
      const estimated = await reauditChunked(s.sampled, rerun, driver, s.marker);
      expect(estimated.completeStore).toBe(true);
      expect(estimated.sampledStoreScored).toBe(true);
      expect(comparable(rescored(estimated))).toEqual(comparable(rescored(full)));
    }, 30_000);

    test(`${driver}: the issue, a 1-page chunked re-audit does not inflate the CLI score`, async () => {
      const shapes = range(0, 100).map((i) => ({ i, metaMissing: true }));
      const s = await seed(shapes);
      const rerun = [shapes[0]!];
      const unmarked = await reauditChunked(structuredCloneStore(s.sampled), rerun, driver);
      expect(rescored(unmarked).healthScore.overall!).toBeGreaterThan(s.cliScore + 2);
      const full = await reauditChunked(s.full, rerun, driver);
      const estimated = await reauditChunked(s.sampled, rerun, driver, s.marker);
      const score = rescored(estimated).healthScore.overall!;
      expect(Math.abs(score - s.cliScore)).toBeLessThanOrEqual(2);
      expect(score).toBeLessThanOrEqual(rescored(full).healthScore.overall!);
    }, 30_000);

    test(`${driver}: partial overlap is never above the full store`, async () => {
      const rand = prng(4626);
      for (let round = 0; round < 8; round++) {
        const pages = 25 + Math.floor(rand() * 50);
        const shapes = randomShapes(rand, range(0, pages));
        const s = await seed(shapes);
        const rerun: PageShape[] = [];
        for (const shape of shapes) {
          if (rand() >= 0.35) continue;
          const roll = rand();
          rerun.push(
            roll < 0.1
              ? { ...shape, status: 404 }
              : roll < 0.25
                ? { ...shape, metaMissing: !shape.metaMissing, ttfb: rand() < 0.5 ? "skipped" : shape.ttfb }
                : shape,
          );
        }
        if (rand() < 0.3) rerun.push(...randomShapes(rand, [pages]));
        const full = await reauditChunked(s.full, rerun, driver);
        const estimated = await reauditChunked(s.sampled, rerun, driver, s.marker);
        const est = rescored(estimated).healthScore;
        const ref = rescored(full).healthScore;
        const label = `${driver} round ${round}: ${pages} pages, ${rerun.length} re-audited`;
        expect({ label, ok: est.overall! <= ref.overall! }).toEqual({ label, ok: true });
        for (const c of est.categories) {
          const refScore = ref.categories.find((r) => r.category === c.category)?.score ?? 100;
          expect({ label, category: c.category, ok: c.score <= refScore }).toEqual({
            label,
            category: c.category,
            ok: true,
          });
        }
      }
    }, 120_000);

    test(`${driver}: a 3-name rule's passes equal the full store's, fold and estimator share one K (#3360 review)`, async () => {
      const shapes: PageShape[] = range(0, 60).map((i) => ({ i, tri: true }));
      const s = await seed(shapes);
      const rerun: PageShape[] = range(60, 80).map((i) => ({ i, tri: false }));
      const full = await reauditChunked(s.full, rerun, driver);
      const estimated = await reauditChunked(s.sampled, rerun, driver, s.marker);
      expect(estimated.sampledStoreScored).toBe(true);
      expect(tallies(full).get("x/tri")!.tally).toMatchObject({ failed: 144, passed: 48 });
      expect(tallies(estimated).get("x/tri")!.tally).toEqual(tallies(full).get("x/tri")!.tally);
    }, 30_000);

    test(`${driver}: without the marker the result is unchanged`, async () => {
      const shapes = busyShapes(range(0, 60));
      const rerun = busyShapes(range(0, 20));
      const a = await reauditChunked((await seed(shapes)).sampled, rerun, driver);
      const b = await reauditChunked((await seed(shapes)).sampled, rerun, driver, {
        ...(await seed(shapes)).marker,
        sampled: false,
      });
      expect(b).toEqual(a);
      expect(a.sampledStoreScored).toBeUndefined();
    }, 30_000);
  }
});

describe("one checks-per-page rule for the fold and the estimator (repo#3360)", () => {
  const perPage = {
    "x/tri": { a: { passed: 2, failed: 0 }, b: { passed: 2, failed: 0 }, c: { passed: 1, failed: 0 } },
  } as CheckTallies;
  const complete = { "x/tri": { a: { passed: 1, failed: 0 } } } as CheckTallies;
  test("complete-store reads the complete tallies (1 without), others the per-page tallies", () => {
    const k = (completeStore: boolean, completeTallies?: CheckTallies) =>
      carriedChecksPerPageFor({ completeStore, completeTallies, perPageTallies: perPage }, "x/tri");
    expect(k(true)).toBe(1);
    expect(k(true, complete)).toBe(1);
    expect(k(false)).toBe(k(false, complete));
    expect(k(false)).toBeGreaterThan(1);
  });
});

function structuredCloneStore(store: MemStore): MemStore {
  const copy = new MemStore();
  for (const [k, f] of store.findings) copy.findings.set(k, { ...f });
  for (const [k, p] of store.pages) copy.pages.set(k, { ...p });
  return copy;
}

describeSitePagesContract("sampled-store-3373.test.ts MemStore", () => new MemStore());
