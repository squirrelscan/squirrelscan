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
  ResolutionSignal,
  SitePageRecord,
} from "@squirrelscan/core-contracts";
import {
  resolutionUrlHash,
  SCAN_TRUNCATED_SKIP_REASON,
} from "@squirrelscan/core-contracts/resolution";
import { decodeResolutionSignal } from "@squirrelscan/rules/resolution-decode";
import {
  buildCompactResolutionSignal,
  buildResolutionSignal,
} from "@squirrelscan/rules/resolution";
import {
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
} from "@squirrelscan/utils/constants";

import {
  aggregateUntouchedCarried,
  isAggregatableCarriedRow,
  type UntouchedCarriedPage,
} from "../src/complete-store-fold";
import { findingKey } from "../src/merge-core";
import {
  runCloudSmartAudits,
  type CloudSmartAuditsInput,
  type CloudSmartAuditsResult,
  type CompleteStoreScope,
  type SmartAuditStore,
} from "../src/merge-promise";
import { buildCheckTallies, capReportForPublish } from "../src/publish-cap";
import { calculateHealthScore, calculateHealthScoreFromTallies } from "../src/scoring";
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
/**
 * A page URL with a high-entropy tail, as on a site whose list the signal's byte
 * budget clips: short regular URLs deflate to less than the hash that would
 * stand in for them, so they are never worth clipping (#2673).
 */
const noisy = (u: string): string =>
  `${u}-${[0, 1, 2, 3, 4, 5].map((k) => resolutionUrlHash(`${u}${"#".repeat(k)}`)).join("")}`;

/** `report` with every page URL made {@link noisy}. */
function withNoisyUrls<T extends { pages: Array<{ url: string }>; ruleResults: Rules }>(report: T): T {
  const out = structuredClone(report);
  for (const page of out.pages) page.url = noisy(page.url);
  for (const rule of Object.values(out.ruleResults)) {
    for (const check of rule.checks) {
      if (check.pageUrl) check.pageUrl = noisy(check.pageUrl);
      if (check.pages) check.pages = check.pages.map(noisy);
      for (const item of check.items ?? []) {
        if (item.sourcePages) item.sourcePages = item.sourcePages.map(noisy);
      }
    }
  }
  return out;
}

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
  /** core/meta-description could not evaluate the page (wins over `metaMissing`). */
  metaSkipped?: boolean;
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
        status: s.metaSkipped ? "skipped" : s.metaMissing ? "fail" : "pass",
        message: s.metaSkipped
          ? "Not evaluated"
          : s.metaMissing
            ? "Missing meta description"
            : "Meta description present",
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

/** A producer's report, with the signal it built when it brings its own. */
type Produced = ReturnType<typeof fullReport> & { resolutionSignal?: ResolutionSignal };

/** Today's uncapped body: every row, the non-2xx statuses, the unsampled signal. */
function uncappedBody(report: Produced) {
  return {
    ruleResults: report.ruleResults,
    pageStatuses: report.pages
      .filter((p) => p.statusCode < 200 || p.statusCode >= 300)
      .map((p) => ({ url: p.url, status: p.statusCode })),
    resolutionSignal:
      report.resolutionSignal ??
      buildResolutionSignal(
        report.ruleResults,
        report.pages.map((p) => p.url),
      ),
  };
}

/**
 * The capped body the CLI and the container publish after repo#2656, as the
 * server merge reads it: the compact signal decoded (repo#2658). A test that
 * hands the report its own signal stands in for a producer that sent that one.
 */
async function cappedBody(report: Produced) {
  const capped = capReportForPublish(report);
  return {
    ruleResults: capped.ruleResults as unknown as Rules,
    pageStatuses: capped.pageStatuses ?? [],
    resolutionSignal:
      report.resolutionSignal ??
      (capped.resolutionSignalCompact
        ? await decodeResolutionSignal(capped.resolutionSignalCompact)
        : undefined),
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

type Body = ReturnType<typeof uncappedBody> | Awaited<ReturnType<typeof cappedBody>>;

function publish(store: MemStore, crawlId: string, body: Body, now: number) {
  return runCloudSmartAudits({ store, siteKey: "site", crawlId, now, ...body });
}

/** Publishes the same audit uncapped and capped to two copies of `seed`. */
async function bothWays(seed: MemStore, crawlId: string, report: Produced) {
  const now = 1_780_000_000_000;
  const uncappedStore = seed.clone();
  const cappedStore = seed.clone();
  const capped = await cappedBody(report);
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
    const { uncapped, capped, cappedBody: body } = await bothWays(new MemStore(), "audit_1", report);
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    expect(rescored(capped).totals.passed).toBeGreaterThan(0);
    expect(capped.coverage).toEqual(uncapped.coverage);
    // Rules of passes only publish no rows at all, and still score from their tallies.
    expect(body.ruleResults["core/meta-description"]!.checks).toEqual([]);
    for (const ruleId of Object.keys(body.checkTallies)) {
      expect(capped.scoringTallies!.get(ruleId)?.tally.passed).toBeGreaterThan(0);
    }
  });

  test("a truncated signal key: a clipped page still failing is counted once, by the tallies", async () => {
    const shapes = range(0, 30).map((i) => ({ i, metaMissing: i < 15 }));
    const seed = await seeded(fullReport(shapes));
    // Run 2 fails the same 15 pages; the sample keeps 10, the merge carries the
    // other 5. The signal's failing set for the check was clipped to 3 hashes, so
    // it is truncated and lists no page as not evaluated.
    const report = fullReport(shapes);
    const key = "core/meta-description|has-meta-description";
    const signal = buildResolutionSignal(report.ruleResults, report.pages.map((p) => p.url))!;
    signal.failing[key] = signal.failing[key]!.slice(0, 3);
    signal.truncated = [...(signal.truncated ?? []), key];
    if (signal.notEvaluated) delete signal.notEvaluated[key];
    const { uncapped, capped } = await bothWays(seed, "audit_2", {
      ...report,
      resolutionSignal: signal,
    });
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    expect(capped.coverage).toEqual(uncapped.coverage);
    expect(capped.coverage.carriedFindings).toBe(0);
    expect(capped.carriedLastSeen.size).toBe(0);
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

  /**
   * The capped body of `report` with its signal clipped to the first `listed`
   * pages, as the builder clips a crawl too big for its byte budget.
   */
  async function clippedBody(
    report: ReturnType<typeof fullReport>,
    listed: number,
    { hashes = true }: { hashes?: boolean } = {},
  ) {
    const urls = report.pages.map((p) => p.url);
    let budget = JSON.stringify(buildCompactResolutionSignal(report.ruleResults, urls)).length;
    let signal: ResolutionSignal;
    do {
      budget -= 64;
      // With page hashes as the capper asks for them (it sends tallies, #2673).
      signal = await decodeResolutionSignal(
        buildCompactResolutionSignal(report.ruleResults, urls, budget, [], { pageHashes: hashes })!,
      );
    } while (signal.crawledUrls.length > listed);
    expect(signal.crawledComplete).toBe(false);
    expect(signal.crawledCount).toBe(urls.length);
    // (#2673) The unlisted crawled pages' hashes ride along; a producer before
    // #2673, or one that sends no tallies, sends none.
    if (hashes) expect(signal.crawledHashes).toHaveLength(urls.length - signal.crawledUrls.length);
    else expect(signal.crawledHashes).toBeUndefined();
    return { ...(await cappedBody(report)), resolutionSignal: signal };
  }
  const NOW = 1_780_000_000_000;

  test("off a clipped signal list, no carried page is credited with passes the tallies hold", async () => {
    // A clean first audit leaves no findings, only pages. Run 2 crawls the same
    // 40 pages and its tallies count every one of them; past the list the signal
    // cannot say they were crawled, and crediting them would count their passes twice.
    const seed = await seeded(withNoisyUrls(fullReport(range(0, 40).map((i) => ({ i })))));
    const report = withNoisyUrls(fullReport(busyShapes(range(0, 40))));
    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    const capped = await publish(seed.clone(), "audit_2", await clippedBody(report, 15), NOW);
    expect(capped.scoringTallies).toBeDefined();
    expect(rescored(capped).healthScore.overall).toBeLessThanOrEqual(
      rescored(uncapped).healthScore.overall,
    );
  });

  test("a clipped list without hashes (before #2673) keeps a carry on a page the payload names", async () => {
    // Run 1: ttfb slow on every page. Run 2: no timing data on page 33, which
    // the payload names (its meta-description fail is in the sample) but the
    // clipped list does not. Without the hashes there is no telling the page was
    // crawled, so its ttfb carry stays scored.
    const seed = await seeded(
      withNoisyUrls(fullReport(range(0, 40).map((i) => ({ i, ttfb: "slow" as const })))),
    );
    const report = withNoisyUrls(
      fullReport(
        range(0, 40).map((i) => ({
          i,
          ttfb: i === 33 ? ("skipped" as const) : ("slow" as const),
          metaMissing: i >= 30,
        })),
      ),
    );
    const body = await clippedBody(report, 15, { hashes: false });
    expect(body.ruleResults["core/meta-description"]!.checks.flatMap((c) => c.pages ?? [])).toContain(
      noisy(url(33)),
    );
    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    const capped = await publish(seed.clone(), "audit_2", body, NOW);
    expect(rescored(capped).healthScore.overall).toBeLessThanOrEqual(
      rescored(uncapped).healthScore.overall,
    );
    expect(capped.carriedLastSeen.has(`${noisy(url(33))}|perf/ttfb|ttfb`)).toBe(true);
  });

  test("(#2673) an unlisted page the hashes name counts as evaluated: its carry is not counted twice", async () => {
    // Every page fails meta-description in both runs. The publish samples 10 of
    // them and the list names 15, so the merge carries the rest; the tallies
    // already count them, and the union must not count them again.
    const shapes = range(0, 40).map((i) => ({ i, metaMissing: true }));
    const seed = await seeded(withNoisyUrls(fullReport(shapes)));
    const report = withNoisyUrls(fullReport(shapes));
    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    const hashed = await publish(seed.clone(), "audit_2", await clippedBody(report, 15), NOW);
    const bare = await publish(
      seed.clone(),
      "audit_2",
      await clippedBody(report, 15, { hashes: false }),
      NOW,
    );
    const carried = (r: CloudSmartAuditsResult) =>
      [...r.carriedLastSeen.keys()].filter((k) =>
        k.endsWith("|core/meta-description|has-meta-description"),
      );
    expect(carried(hashed)).toEqual([]);
    expect(carried(bare).length).toBeGreaterThan(0);
    expect(comparable(rescored(hashed))).toEqual(comparable(rescored(uncapped)));
  });

  test("(#2688) an unlisted page the check skipped keeps its carry, one it evaluated does not", async () => {
    // ttfb has no timing data on every fourth page, some listed and some not.
    // The signal names the unlisted ones the check skipped: their carries stay,
    // where no tally replaces them, and every other carry leaves the union.
    const seed = await seeded(
      withNoisyUrls(fullReport(range(0, 40).map((i) => ({ i, ttfb: "slow" as const })))),
    );
    const skipped = range(0, 40).filter((i) => i % 4 === 3);
    const report = withNoisyUrls(
      fullReport(
        range(0, 40).map((i) => ({
          i,
          ttfb: skipped.includes(i) ? ("skipped" as const) : ("slow" as const),
        })),
      ),
    );
    const body = await clippedBody(report, 15);
    const listed = new Set(body.resolutionSignal.crawledUrls);
    const unlisted = skipped.map((i) => noisy(url(i))).filter((u) => !listed.has(u));
    expect(unlisted.length).toBeGreaterThan(0);
    expect(unlisted.length).toBeLessThan(skipped.length);
    const capped = await publish(seed.clone(), "audit_2", body, NOW);
    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    // Shown as carried: the skipped pages, listed or not, and no other.
    const ttfbCarries = [...capped.carriedLastSeen.keys()].filter((k) => k.endsWith("|perf/ttfb|ttfb"));
    expect(new Set(ttfbCarries)).toEqual(new Set(skipped.map((i) => `${noisy(url(i))}|perf/ttfb|ttfb`)));
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
  });

  test("(#2688) one skipped unlisted page keeps its prior fail in the score, on a check that evaluated every listed page", async () => {
    // Every page failed meta-description in run 1. Run 2 fixes it everywhere,
    // but the rule could not evaluate page 39, which the clipped list leaves out.
    // Nothing listed shows the skip, so only the signal's word on page 39 keeps
    // its fail carried, as the uncapped merge carries it; without it the capped
    // score comes out above the uncapped one.
    const seed = await seeded(
      withNoisyUrls(fullReport(range(0, 40).map((i) => ({ i, metaMissing: true })))),
    );
    const report = withNoisyUrls(
      fullReport(range(0, 40).map((i) => ({ i, metaSkipped: i === 39 }))),
    );
    const body = await clippedBody(report, 15);
    const page = noisy(url(39));
    expect(body.resolutionSignal.crawledUrls).not.toContain(page);
    expect(body.resolutionSignal.crawledHashes).toContain(resolutionUrlHash(page));
    const key = "core/meta-description|has-meta-description";
    const listed = new Set(body.resolutionSignal.crawledUrls.map((u) => resolutionUrlHash(u)));
    expect(body.resolutionSignal.notEvaluated?.[key]?.some((hash) => listed.has(hash)) ?? false).toBe(
      false,
    );

    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    const capped = await publish(seed.clone(), "audit_2", body, NOW);
    expect(rescored(capped).healthScore.overall).toBeLessThanOrEqual(
      rescored(uncapped).healthScore.overall,
    );
    expect(comparable(rescored(capped))).toEqual(comparable(rescored(uncapped)));
    expect(uncapped.carriedLastSeen.has(`${page}|${key}`)).toBe(true);
    expect(capped.carriedLastSeen.has(`${page}|${key}`)).toBe(true);
  });

  test("(#2673) uncrawled carried pages keep their synthetic passes; a hash collision only withholds one", async () => {
    // Run 2 crawls 30 of the 40 known pages, clipped to 15 listed. Pages 30-39
    // were not crawled: the uncapped merge credits them with clean passes, and
    // with the hashes the capped one does too. Without them it credits none.
    const seed = await seeded(withNoisyUrls(fullReport(range(0, 40).map((i) => ({ i })))));
    const report = withNoisyUrls(fullReport(busyShapes(range(0, 30))));
    const uncapped = await publish(seed.clone(), "audit_2", uncappedBody(report), NOW);
    const body = await clippedBody(report, 15);
    const hashed = await publish(seed.clone(), "audit_2", body, NOW);
    const bare = await publish(
      seed.clone(),
      "audit_2",
      await clippedBody(report, 15, { hashes: false }),
      NOW,
    );
    expect(rescored(hashed).healthScore.overall).toBe(rescored(uncapped).healthScore.overall);
    const passed = (r: CloudSmartAuditsResult) =>
      [...r.scoringTallies!.values()].reduce((n, rule) => n + rule.tally.passed, 0);
    expect(passed(bare)).toBeLessThan(passed(hashed));

    // An uncrawled page whose hash collides with a crawled one is not credited.
    const collided = await publish(
      seed.clone(),
      "audit_2",
      {
        ...body,
        resolutionSignal: {
          ...body.resolutionSignal,
          crawledHashes: [...body.resolutionSignal.crawledHashes!, resolutionUrlHash(noisy(url(35)))],
        },
      },
      NOW,
    );
    expect(passed(collided)).toBeLessThan(passed(hashed));
    expect(passed(collided)).toBeGreaterThan(passed(bare));
  });

  test(
    "(#2673) a clipped 10,000-page crawl of random URLs scores at most the uncapped body, within a point",
    async () => {
      // Run 1 audits 10,000 pages. Run 2 re-crawls 9,000 of them through the real
      // capper, whose signal budget clips the list of random URLs; the other
      // 1,000 are carried.
      const seed = await seeded(withNoisyUrls(fullReport(busyShapes(range(0, 10_000)))));
      const report = withNoisyUrls(
        fullReport(busyShapes(range(0, 9_000)).map((s) => ({ ...s, readability: !s.readability }))),
      );
      const body = await cappedBody(report);
      expect(body.resolutionSignal?.crawledComplete).toBe(false);
      expect(body.resolutionSignal?.crawledHashes?.length).toBeGreaterThan(0);
      const uncapped = rescored(await publish(seed.clone(), "audit_2", uncappedBody(report), NOW));
      const capped = rescored(await publish(seed.clone(), "audit_2", body, NOW));
      expect(capped.healthScore.overall).toBeLessThanOrEqual(uncapped.healthScore.overall);
      expect(uncapped.healthScore.overall - capped.healthScore.overall).toBeLessThanOrEqual(1);
      // (#2688) With the unlisted skips named, the counts come out exact.
      expect(capped.totals).toEqual(uncapped.totals);
    },
    240_000,
  );

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

  test("a tally for a rule the report does not carry is not scored", async () => {
    // No meta, so nothing to score it under, as no row of it could have been.
    const report = fullReport(busyShapes(range(0, 20)));
    const body = await cappedBody(report);
    const ghost = {
      ...body,
      checkTallies: { ...body.checkTallies, "core/ghost": { ghost: { failed: 99, failUnits: 99 } } },
    };
    const now = 1_780_000_000_000;
    const plain = await publish(new MemStore(), "audit_1", body, now);
    const withGhost = await publish(new MemStore(), "audit_1", ghost, now);
    expect(withGhost.scoringTallies!.has("core/ghost")).toBe(false);
    expect(rescored(withGhost)).toEqual(rescored(plain));
  });

  test("a report without tallies (an older producer) keeps the row-counting path", async () => {
    const report = fullReport(busyShapes(range(0, 20)));
    const r = await publish(new MemStore(), "audit_1", uncappedBody(report), 1);
    expect(r.scoringTallies).toBeUndefined();
    expect(r.reportTotals).toBeUndefined();
  });
});

// ── repo#3348: the same capped report, published chunked ─────────────────────

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

/** The finalize's three ways of reading the store. */
const DRIVERS = ["cursor", "arrays", "split"] as const;
type Driver = (typeof DRIVERS)[number];

/**
 * The same audit as the container publishes it chunked: the full report's
 * findings stream into the store first, then the finalize merges the capped
 * shell. `driver` is the finalize's read of the store:
 *  - `cursor`: one cursor over the site's open rows;
 *  - `arrays`: this run's rows beside the earlier ones (the whole-array driver);
 *  - `split`: the cursor over touched pages only, the untouched ones as one
 *    aggregate and a sample (pub#497), as the API reads it by default.
 * `tallies: false` is a shell without `checkTallies`.
 */
async function publishChunked(
  store: MemStore,
  crawlId: string,
  report: Produced,
  now: number,
  opts: { driver?: Driver; tallies?: boolean; signal?: boolean } = {},
) {
  const body = await cappedBody(report);
  await store.upsertFindings(
    buildStreamFindings(report.ruleResults, now).map((line) => ({
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
    // The store's own carry of the rows the merge never sees.
    for (const p of untouched) {
      for (const r of p.rows) {
        await store.upsertFindings([{ ...r, provenance: "carried" }]);
      }
    }
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
    now,
    ruleResults: body.ruleResults,
    pageStatuses: body.pageStatuses,
    ...(opts.signal === false ? {} : { resolutionSignal: body.resolutionSignal }),
    ...(opts.tallies === false ? {} : { checkTallies: body.checkTallies }),
    completeStore:
      opts.driver === "arrays"
        ? {
            findingPages: findingPages(),
            priorOpenFindings: pages.flatMap(([, rows]) => prior(rows)),
            crawledUrls,
          }
        : opts.driver === "split"
          ? { untouchedCarried, crawledUrls }
          : { openPages: openPages(), crawledUrls },
  });
}

/** Rules that ran and evaluated no page: a site with no video and no address. */
function withIdleRules(report: ReturnType<typeof fullReport>) {
  report.ruleResults["video/video-schema"] = {
    meta: meta("video/video-schema", "video", "page", "warning", 5),
    checks: [],
  };
  report.ruleResults["local/nap"] = {
    meta: meta("local/nap", "local", "page", "warning", 5),
    checks: [],
  };
  return report;
}

/** busyShapes, plus meta descriptions the rule could not evaluate on some pages. */
function skipShapes(pages: number[]): PageShape[] {
  return busyShapes(pages).map((s) => ({ ...s, metaSkipped: s.i % 13 === 0 }));
}

const categoriesOf = (r: CloudSmartAuditsResult): string[] =>
  rescored(r).healthScore.categories.map((c) => c.category);

describe("a capped report published chunked scores as published in one POST (repo#3348)", () => {
  test("first audit: either finalize driver gives the one-POST score, totals and coverage", async () => {
    const report = withIdleRules(fullReport(skipShapes(range(0, 60)), { robotsMissing: true }));
    const now = 1_780_000_000_000;
    const single = await publish(new MemStore(), "audit_1", await cappedBody(report), now);
    const uncapped = await publish(new MemStore(), "audit_1", uncappedBody(report), now);
    expect(comparable(rescored(single))).toEqual(comparable(rescored(uncapped)));

    for (const driver of DRIVERS) {
      const chunked = await publishChunked(new MemStore(), "audit_1", report, now, { driver });
      expect(chunked.completeStore).toBe(true);
      expect(comparable(rescored(chunked))).toEqual(comparable(rescored(single)));
      expect(chunked.coverage).toEqual(single.coverage);
      // Rules that evaluated no page score nothing, so their categories stay out.
      expect(categoriesOf(chunked)).not.toContain("video");
      expect(categoriesOf(chunked)).not.toContain("local");
    }
  });

  test("tallies without the signal leave the chunked shell on its findings, as one POST leaves them", async () => {
    // The signal is what says which carries the tallies already count.
    const report = withIdleRules(fullReport(skipShapes(range(0, 60)), { robotsMissing: true }));
    const now = 1_780_000_000_000;
    const noSignal = await publishChunked(new MemStore(), "audit_1", report, now, { signal: false });
    const noTallies = await publishChunked(new MemStore(), "audit_1", report, now, { tallies: false });
    expect(noSignal.reportTotals).toBeUndefined();
    expect(comparable(rescored(noSignal)).healthScore).toEqual(
      comparable(rescored(noTallies)).healthScore,
    );
  });

  test("without the tallies the chunked shell scores skipped and idle pages as passes", async () => {
    // The drift the tallies remove, measured on the fixture above.
    const report = withIdleRules(fullReport(skipShapes(range(0, 60)), { robotsMissing: true }));
    const now = 1_780_000_000_000;
    const single = await publish(new MemStore(), "audit_1", await cappedBody(report), now);
    const control = await publishChunked(new MemStore(), "audit_1", report, now, { tallies: false });
    expect(control.reportTotals).toBeUndefined();
    expect(categoriesOf(control)).toContain("video");
    expect(rescored(control).healthScore.overall).toBeGreaterThan(
      rescored(single).healthScore.overall!,
    );
  });

  test("a chunked publish stores every failing page, so a partial re-run after it scores as after an uncapped one", async () => {
    const full = fullReport(busyShapes(range(0, 60)));
    const t1 = 1_779_000_000_000;
    const viaChunked = new MemStore();
    const first = await publishChunked(viaChunked, "audit_1", full, t1);
    const viaUncapped = new MemStore();
    await publish(viaUncapped, "audit_1", uncappedBody(full), t1);
    const viaCapped = new MemStore();
    await publish(viaCapped, "audit_1", await cappedBody(full), t1);

    const keys = async (store: MemStore) =>
      (await store.getFindings("site", ["open"]))
        .map((f) => findingKey(f.normalizedUrl, f.ruleId, f.checkName, f.locator))
        .sort();
    expect(await keys(viaChunked)).toEqual(await keys(viaUncapped));
    const failing = range(0, 60).filter((i) => i % 3 === 0).length;
    const metaOpen = (store: MemStore) =>
      openUrls(store, "core/meta-description", "has-meta-description");
    expect((await metaOpen(viaChunked)).size).toBe(failing);
    // One POST of the capped body stores its 10-page sample of the class.
    expect((await metaOpen(viaCapped)).size).toBeLessThanOrEqual(10);

    // Run 2 re-crawls three unchanged pages and publishes them as one POST.
    const rerun = await cappedBody(fullReport(busyShapes(range(0, 3))));
    const now = 1_780_000_000_000;
    const afterChunked = await publish(viaChunked, "audit_2", rerun, now);
    const afterUncapped = await publish(viaUncapped, "audit_2", rerun, now);
    const afterCapped = await publish(viaCapped, "audit_2", rerun, now);
    expect(comparable(rescored(afterChunked))).toEqual(comparable(rescored(afterUncapped)));
    expect(afterChunked.coverage).toEqual(afterUncapped.coverage);
    // The carried side is the whole class, so nothing scores better than the full
    // audit did. (It scores a little worse: the replay counts each stored item as
    // a check of its own, squirrelscan/repo#3360.)
    const fullScore = rescored(first).healthScore.overall!;
    expect(rescored(afterChunked).healthScore.overall!).toBeLessThanOrEqual(fullScore);
    // After the sampled store the re-run scores the clipped pages clean.
    expect(rescored(afterCapped).healthScore.overall!).toBeGreaterThan(fullScore);
  });

  test("partial re-audit published chunked: the one-POST score, crawled-clean resolves, uncrawled carries", async () => {
    const seed = await seeded(fullReport(busyShapes(range(0, 60))));
    const shapes = busyShapes(range(0, 40)).map((s) => ({
      ...s,
      metaMissing: s.i >= 20 && s.i < 30 ? true : s.i < 20 ? false : s.metaMissing,
      status: s.i === 30 ? 404 : undefined,
    }));
    const report = fullReport(shapes);
    const now = 1_780_000_000_000;
    const single = await publish(seed.clone(), "audit_2", await cappedBody(report), now);
    for (const driver of DRIVERS) {
      const store = seed.clone();
      const chunked = await publishChunked(store, "audit_2", report, now, { driver });
      expect(chunked.coverage.carriedFindings).toBeGreaterThan(0);
      expect(comparable(rescored(chunked))).toEqual(comparable(rescored(single)));
      const open = await openUrls(store, "core/meta-description", "has-meta-description");
      for (const i of range(0, 20)) expect(open.has(url(i))).toBe(false);
      for (const i of range(20, 30)) expect(open.has(url(i))).toBe(true);
      for (const i of range(40, 60).filter((i) => i % 3 === 0)) expect(open.has(url(i))).toBe(true);
      expect(open.has(url(30))).toBe(false);
      expect(chunked.coverage).toEqual(single.coverage);
    }
  });

  test("a check skipped on a crawled page keeps its prior open and scored, as in one POST (#508)", async () => {
    const seed = await seeded(fullReport(busyShapes(range(0, 60))));
    // Run 1 had slow TTFB on 12, 18 and 24 and no meta description on 0, 3 and 6.
    // Run 2 could not evaluate those checks there.
    const shapes = busyShapes(range(0, 40)).map((s) => ({
      ...s,
      ttfb: [12, 18, 24].includes(s.i) ? ("skipped" as const) : s.ttfb,
      metaSkipped: [0, 3, 6].includes(s.i),
    }));
    const report = fullReport(shapes);
    const now = 1_780_000_000_000;
    const singleStore = seed.clone();
    const single = await publish(singleStore, "audit_2", await cappedBody(report), now);
    const skippedOpen = async (store: MemStore) => ({
      ttfb: [...(await openUrls(store, "perf/ttfb", "ttfb"))].filter((u) =>
        [12, 18, 24].map(url).includes(u),
      ).length,
      meta: [...(await openUrls(store, "core/meta-description", "has-meta-description"))].filter(
        (u) => [0, 3, 6].map(url).includes(u),
      ).length,
    });
    expect(await skippedOpen(singleStore)).toEqual({ ttfb: 3, meta: 3 });
    for (const driver of DRIVERS) {
      const store = seed.clone();
      const chunked = await publishChunked(store, "audit_2", report, now, { driver });
      expect(comparable(rescored(chunked))).toEqual(comparable(rescored(single)));
      expect(chunked.coverage).toEqual(single.coverage);
      expect(await skippedOpen(store)).toEqual({ ttfb: 3, meta: 3 });
    }
  });

  test("first audit with removed pages that hold findings: the one-POST score on every driver", async () => {
    const shapes = busyShapes(range(0, 50)).map((s) => ({
      ...s,
      status: s.i === 9 || s.i === 12 ? 404 : undefined,
    }));
    const report = fullReport(shapes, { robotsMissing: true });
    const now = 1_780_000_000_000;
    const single = await publish(new MemStore(), "audit_1", await cappedBody(report), now);
    for (const driver of DRIVERS) {
      const chunked = await publishChunked(new MemStore(), "audit_1", report, now, { driver });
      expect(comparable(rescored(chunked))).toEqual(comparable(rescored(single)));
      expect(chunked.coverage).toEqual(single.coverage);
    }
  });

  test("a re-run of a large site carries more rows per rule than the report keeps: still the one-POST score", async () => {
    const seed = await seeded(fullReport(busyShapes(range(0, 200))));
    const report = fullReport(busyShapes(range(0, 15)));
    const now = 1_780_000_000_000;
    const single = await publish(seed.clone(), "audit_2", await cappedBody(report), now);
    for (const driver of DRIVERS) {
      const chunked = await publishChunked(seed.clone(), "audit_2", report, now, { driver });
      expect(comparable(rescored(chunked))).toEqual(comparable(rescored(single)));
      expect(chunked.coverage).toEqual(single.coverage);
    }
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
    // Nor shown: the class names 10 live pages and counts no more.
    const [cls] = capped.ruleResults["core/meta-description"]!.checks;
    expect(cls!.pages).not.toContain(url(3));
    expect(cls!.pages).not.toContain(url(4));
    expect(cls!.details?.occurrences).toBe(10);
  });

  test("removed pages are read from the producer's pageStatuses when it sent them, as the server reads them", () => {
    const report = {
      ...fullReport(range(0, 12).map((i) => ({ i, metaMissing: true, status: i === 3 ? 404 : undefined }))),
      // The statuses the server will see: page 4 gone, page 3 not listed.
      pageStatuses: [{ url: url(4), status: 410 }],
    };
    const capped = capReportForPublish(report);
    expect(capped.pageStatuses).toEqual([{ url: url(4), status: 410 }]);
    expect(capped.checkTallies["core/meta-description"]).toEqual({
      "has-meta-description": { failed: 11, failUnits: 11 },
    });
    expect(capped.ruleResults["core/meta-description"]!.checks[0]!.pages).not.toContain(url(4));
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

describeSitePagesContract("capped-rescore.test.ts MemStore", () => new MemStore());
