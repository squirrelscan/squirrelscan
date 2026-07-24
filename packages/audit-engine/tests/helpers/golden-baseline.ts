// Golden-baseline machinery for the streaming-engine migration (#1021/#1022,
// blueprint plans/scale-1021-1022-blueprint.md §5). v1 (this file's target)
// stays untouched while v2 (streaming.ts + report-stream.ts, not built yet)
// lands beside it, flag-gated — the migration's correctness gate is: run the
// SAME crawl DB through v1 and v2, diff the comparable surface, zero
// divergence. This module provides BOTH halves of that gate:
//
//   captureEngineBaseline(storagePath, config) — run the CURRENT v1 pipeline
//     (getPages -> buildSiteContext -> runRulesOnStorage ->
//     generateReportFromStorage) over an already-written crawl DB and
//     capture a deterministic, comparable snapshot (health score, full
//     finding set, per-rule tally, summary.*).
//
//   diffBaselines(a, b) — deep-compare two snapshots and produce a readable
//     divergence report (grouped/sorted by rule, capped to the first N).
//
// `runV1Pipeline` is the shared inner wiring both this module's capture AND
// the memory harness (tests/memory-harness.test.ts) build on, so there is
// exactly ONE place that chains the four pipeline calls.

import type {
  Config,
  CrawlStorage,
  FullAuditReport,
  PageRecord,
  PreFetchedAssets,
  RuleExecutionResult,
} from "@squirrelscan/audit-engine";
import type { CheckStatus } from "@squirrelscan/core-contracts";
import type { PageRuleLoopHooks } from "@squirrelscan/audit-engine";

import type { IssueMixOptions, SiteModel } from "@squirrelscan/synthetic-site";

import {
  buildSiteContext,
  generateReportFromStorage,
  runRulesOnStorage,
  runStreamingRules,
} from "@squirrelscan/audit-engine";
import { getDefaultConfig } from "@squirrelscan/config";
import { SQLiteStorage } from "@squirrelscan/crawler";
import { generateSiteModel } from "@squirrelscan/synthetic-site";
import { Effect } from "effect";

export function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff);
}

/**
 * Config for a fully offline, deterministic engine run — no cloud/intel
 * calls, no network. `getDefaultConfig()` alone would already behave this
 * way in an unauthenticated environment (`cloud.enabled`'s own doc comment:
 * "no-op when not logged in"; `intel.enabled` defaults false), but this
 * makes "offline and deterministic" an explicit, visible property of the
 * harness rather than an accident of the ambient environment having no
 * stored credentials.
 */
export function getGoldenBaselineConfig(): Config {
  const base = getDefaultConfig();
  return {
    ...base,
    cloud: { ...base.cloud, enabled: false },
    intel: { ...base.intel, enabled: false },
  };
}

/** A plain, empty PreFetchedAssets — deliberately NOT calling the real
 * `fetchResourceAssets` (which does live network I/O for CSS/JS/image sizing)
 * so the pipeline stays fully offline and deterministic. Synthetic pages
 * carry no real sub-resources to size anyway. */
function emptyAssets(): PreFetchedAssets {
  return {
    resourceSizes: { css: [], images: [] },
    scripts: [],
    pdfSizes: [],
    sitemapUrlStatuses: [],
  };
}

export interface RunV1PipelineOptions {
  /** Threaded into runRulesOnStorage for cooperative-yield RSS sampling (memory harness only). */
  pageLoopHooks?: PageRuleLoopHooks;
  /** Fired around each major phase boundary — the memory harness's RSS sample points. */
  onPhase?: (phase: string) => void;
}

export interface V1PipelineResult {
  pages: PageRecord[];
  ruleResults: RuleExecutionResult;
  report: FullAuditReport;
}

/**
 * The one place that chains getPages -> buildSiteContext -> runRulesOnStorage
 * -> generateReportFromStorage — mirrors the real production wiring in
 * packages/audit-engine/src/cloud-runner.ts (around its `runRulesOnStorage`/
 * `generateReportFromStorage` call sites), minus the network-touching steps
 * (external-link checking, resource-asset fetching, tech detection) this
 * harness has no use for.
 */
export async function runV1Pipeline(
  storage: CrawlStorage,
  crawlId: string,
  config: Config,
  opts: RunV1PipelineOptions = {},
): Promise<V1PipelineResult> {
  opts.onPhase?.("get-pages:start");
  const pages = await run(storage.getPages(crawlId));
  opts.onPhase?.("get-pages:end");

  opts.onPhase?.("build-site-context:start");
  const siteContext = await run(buildSiteContext(pages));
  opts.onPhase?.("build-site-context:end");

  const assets = emptyAssets();

  opts.onPhase?.("rules:start");
  const ruleResults = await run(
    runRulesOnStorage(storage, crawlId, siteContext, config, assets, undefined, opts.pageLoopHooks),
  );
  opts.onPhase?.("rules:end");

  opts.onPhase?.("report:start");
  const report = await run(generateReportFromStorage(storage, crawlId, ruleResults));
  opts.onPhase?.("report:end");

  return { pages, ruleResults, report };
}

// ── Snapshot shape ───────────────────────────────────────────────────────

export interface RuleFindingSnapshot {
  ruleId: string;
  checkName: string;
  status: CheckStatus;
  /** null for site-scope checks (no single page). */
  pageUrl: string | null;
}

/**
 * A plain per-(ruleId, status) check-count histogram, deterministically
 * derived from `RuleExecutionResult.ruleResultsMap` (the uncapped finding
 * set). This is INTENTIONALLY NOT the internal scoring engine's item/unit-
 * aware `IssueTally` (packages/audit-engine/src/scoring.ts — per-(checkName,
 * pageUrl) capping, per-key MAX of details.additional, distinct-key warn
 * counting) — that type isn't exported, and reimplementing its subtlety here
 * would risk a byte-inexact "golden" tally that's wrong in a different way
 * than the real one. Rather than a wrong reimplementation, this is a
 * simpler, honestly-labeled, fully-deterministic proxy: still a meaningful
 * per-rule divergence signal (a different pass/warn/fail count for a rule
 * between v1 and v2 is real news either way).
 */
export interface RuleTallySnapshot {
  ruleId: string;
  pass: number;
  warn: number;
  fail: number;
  info: number;
  skipped: number;
  total: number;
}

export interface EngineBaselineSnapshot {
  /** Provenance only — NOT compared by diffBaselines (everything else in this snapshot is). */
  meta: { pageCount: number };
  healthScore: {
    overall: number | null;
    categories: Array<{
      category: string;
      name: string;
      score: number;
      passed: number;
      warnings: number;
      failed: number;
      total: number;
    }>;
    groups: Array<{
      group: string;
      name: string;
      score: number;
      passed: number;
      warnings: number;
      failed: number;
      total: number;
    }>;
    errorCount: number;
    warningCount: number;
    passedCount: number;
  };
  /** Full (ruleId, checkName, status, pageUrl) set — sorted, deterministic, UNCAPPED. */
  findings: RuleFindingSnapshot[];
  /** Sorted by ruleId. */
  perRuleTally: RuleTallySnapshot[];
  summary: {
    missingTitles: string[];
    missingDescriptions: string[];
    missingOgTags: string[];
    missingTwitterCards: string[];
    missingSchemas: string[];
    missingAltText: Array<{ page: string; image: string }>;
    multipleH1s: string[];
    thinContentPages: string[];
    urlIssues: string[];
    redirectChains: string[];
    securityIssues: string[];
  };
}

function statusBucket(tally: RuleTallySnapshot, status: CheckStatus): void {
  tally.total += 1;
  switch (status) {
    case "pass":
      tally.pass += 1;
      break;
    case "warn":
      tally.warn += 1;
      break;
    case "fail":
      tally.fail += 1;
      break;
    case "info":
      tally.info += 1;
      break;
    case "skipped":
      tally.skipped += 1;
      break;
  }
}

function buildSnapshot(
  pageCount: number,
  ruleResults: RuleExecutionResult,
  report: FullAuditReport,
): EngineBaselineSnapshot {
  const findings: RuleFindingSnapshot[] = [];
  const tallyByRule = new Map<string, RuleTallySnapshot>();

  for (const [ruleId, result] of ruleResults.ruleResultsMap) {
    const tally: RuleTallySnapshot = {
      ruleId,
      pass: 0,
      warn: 0,
      fail: 0,
      info: 0,
      skipped: 0,
      total: 0,
    };
    for (const check of result.checks) {
      findings.push({
        ruleId,
        checkName: check.name,
        status: check.status,
        pageUrl: check.pageUrl ?? null,
      });
      statusBucket(tally, check.status);
    }
    tallyByRule.set(ruleId, tally);
  }

  findings.sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      a.checkName.localeCompare(b.checkName) ||
      a.status.localeCompare(b.status) ||
      (a.pageUrl ?? "").localeCompare(b.pageUrl ?? ""),
  );

  const perRuleTally = [...tallyByRule.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const hs = report.healthScore;
  return {
    meta: { pageCount },
    healthScore: {
      overall: hs.overall,
      categories: [...hs.categories].sort((a, b) => a.category.localeCompare(b.category)),
      groups: [...(hs.groups ?? [])].sort((a, b) => a.group.localeCompare(b.group)),
      errorCount: hs.errorCount,
      warningCount: hs.warningCount,
      passedCount: hs.passedCount,
    },
    findings,
    perRuleTally,
    summary: {
      missingTitles: [...report.summary.missingTitles].sort(),
      missingDescriptions: [...report.summary.missingDescriptions].sort(),
      missingOgTags: [...report.summary.missingOgTags].sort(),
      missingTwitterCards: [...report.summary.missingTwitterCards].sort(),
      missingSchemas: [...report.summary.missingSchemas].sort(),
      missingAltText: [...report.summary.missingAltText].sort(
        (a, b) => a.page.localeCompare(b.page) || a.image.localeCompare(b.image),
      ),
      multipleH1s: [...report.summary.multipleH1s].sort(),
      thinContentPages: [...report.summary.thinContentPages].sort(),
      urlIssues: [...report.summary.urlIssues].sort(),
      redirectChains: [...report.summary.redirectChains].sort(),
      securityIssues: [...report.summary.securityIssues].sort(),
    },
  };
}

/**
 * Runs the CURRENT v1 pipeline over an already-written crawl DB file and
 * captures a deterministic snapshot. Opens its OWN fresh `SQLiteStorage`
 * connection from `storagePath` (rather than accepting an already-open
 * storage instance) so a v1 capture and a future v2 capture can each open
 * independent connections against the SAME saved file — the actual shared
 * artifact per the blueprint's "same 500-page crawl DB through v1+v2".
 */
export async function captureEngineBaseline(
  storagePath: string,
  config: Config,
): Promise<EngineBaselineSnapshot> {
  const storage = new SQLiteStorage(storagePath);
  try {
    await run(storage.init());
    const crawls = await run(storage.listCrawls(1));
    const crawlId = crawls[0]?.id;
    if (!crawlId) {
      throw new Error(`captureEngineBaseline: no crawl found in storage at "${storagePath}"`);
    }
    const { pages, ruleResults, report } = await runV1Pipeline(storage, crawlId, config);
    return buildSnapshot(pages.length, ruleResults, report);
  } finally {
    await run(storage.close());
  }
}

/**
 * The v2 (streaming) side of the migration gate (#1021). Captures the SAME
 * shape of snapshot as {@link captureEngineBaseline} but drives the crawl DB
 * through `runStreamingRules` instead of `runRulesOnStorage`, then diff the two
 * with {@link diffBaselines} — zero divergence is the byte-identical merge gate.
 * Uses the identical offline `emptyAssets()` so the ONLY variable between the two
 * captures is the engine path (v1 resident loop vs v2 streaming loop).
 */
export async function captureStreamingBaseline(
  storagePath: string,
  config: Config,
): Promise<EngineBaselineSnapshot> {
  const storage = new SQLiteStorage(storagePath);
  try {
    await run(storage.init());
    const crawls = await run(storage.listCrawls(1));
    const crawlId = crawls[0]?.id;
    if (!crawlId) {
      throw new Error(`captureStreamingBaseline: no crawl found in storage at "${storagePath}"`);
    }
    // Page count = the full stored set (incl. redirect hops), matching
    // runV1Pipeline's `pages.length`; meta.pageCount is provenance-only (not diffed).
    const pageCount = (await run(storage.getPages(crawlId))).length;
    const ruleResults = await run(runStreamingRules(storage, crawlId, config, emptyAssets()));
    const report = await run(generateReportFromStorage(storage, crawlId, ruleResults));
    return buildSnapshot(pageCount, ruleResults, report);
  } finally {
    await run(storage.close());
  }
}

// ── THE canonical fixture (shared by the v1 baseline test AND the v2 gate) ────
//
// Fixed seed + fixed shape — DO NOT change either without a comment explaining
// why (changing them invalidates the pinned stats the v2 gate asserts and any
// snapshot committed elsewhere). Deliberately richer than synthetic-site's own
// defaults (lower cleanRatio, explicit counts for every issue class) so the
// baseline exercises broad rule coverage. Lives here (not in a .test.ts) so both
// the v1 capture test and the v2 streaming gate build the IDENTICAL crawl.
export const GOLDEN_BASELINE_SEED = "engine-golden-baseline-v1";
export const GOLDEN_BASELINE_PAGE_COUNT = 500;

const GOLDEN_BASELINE_ISSUES: IssueMixOptions = {
  longH1: { ratio: 0.06 },
  oversizeTitle: { ratio: 0.06 },
  oversizeDescription: { ratio: 0.06 },
  longUrls: { ratio: 0.05 },
  duplicateTitles: { groupCount: 8, groupSize: 4 },
  duplicateDescriptions: { groupCount: 6, groupSize: 3 },
  orphanPages: { count: 15 },
  redirectChains: { count: 6, chainLength: 3 },
  brokenLinks: { count: 20 },
  noindexInSitemap: { count: 10 },
};

export function buildGoldenBaselineModel(): SiteModel {
  return generateSiteModel({
    seed: GOLDEN_BASELINE_SEED,
    pageCount: GOLDEN_BASELINE_PAGE_COUNT,
    templateCount: 6,
    minPageSizeBytes: 20_000,
    maxPageSizeBytes: 60_000,
    cleanRatio: 0.35,
    issues: GOLDEN_BASELINE_ISSUES,
  });
}

/** Deterministic JSON serialization — stable because every array in
 * EngineBaselineSnapshot is explicitly sorted before this is called and
 * every object is built with a fixed key order (never spread from a Map's
 * iteration order). Two snapshots of the same audit are byte-identical. */
export function serializeBaseline(snapshot: EngineBaselineSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

// ── Diff ──────────────────────────────────────────────────────────────────

export interface BaselineDivergence {
  /** "(overall)" / "(summary)" for cross-cutting divergences that aren't one rule's fault. */
  ruleId: string;
  kind:
    | "finding-only-in-a"
    | "finding-only-in-b"
    | "tally-mismatch"
    | "score-mismatch"
    | "summary-mismatch";
  detail: string;
}

export interface BaselineDiffResult {
  identical: boolean;
  /** Sorted by ruleId, capped to maxDivergences. */
  divergences: BaselineDivergence[];
  /** Uncapped count — check this against divergences.length to know if the report was truncated. */
  totalDivergences: number;
}

/** ASCII unit separator — not a plausible byte in ruleId/checkName/status/URL,
 * unlike a plain space, which a check name or URL could theoretically contain
 * adjacent to a status word and silently collide two different tuples into
 * one set entry (swallowing a real divergence, exactly what this tool exists
 * to catch). */
const FINDING_KEY_DELIMITER = "\x1f";

function findingKey(f: RuleFindingSnapshot): string {
  return [f.ruleId, f.checkName, f.status, f.pageUrl ?? ""].join(FINDING_KEY_DELIMITER);
}

/** Category/GroupScore field-by-field equality — NOT JSON.stringify. Those
 * objects are constructed by the engine's own scoring code (packages/audit-
 * engine/src/scoring.ts), not by this module, so nothing here guarantees
 * matching object-literal key order between a v1 capture and a future v2
 * capture; two semantically-identical scores with differently-ordered keys
 * would otherwise false-positive as a divergence. */
/* `name` is intentionally excluded: cosmetic display label, not a scoring output. */
function scoreFieldsEqual(
  a: { score: number; passed: number; warnings: number; failed: number; total: number } | undefined,
  b: { score: number; passed: number; warnings: number; failed: number; total: number } | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.score === b.score &&
    a.passed === b.passed &&
    a.warnings === b.warnings &&
    a.failed === b.failed &&
    a.total === b.total
  );
}

function diffStringArray(label: string, a: string[], b: string[]): BaselineDivergence[] {
  if (a.length === b.length && a.every((v, i) => v === b[i])) return [];
  return [
    {
      ruleId: "(summary)",
      kind: "summary-mismatch",
      detail: `${label}: A has ${a.length} entries, B has ${b.length} entries — ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    },
  ];
}

/**
 * Deep-compares two baseline snapshots and produces a readable divergence
 * report, sorted/grouped by ruleId, capped to the first `maxDivergences` (the
 * uncapped `totalDivergences` count is always returned so a truncated report
 * is never mistaken for a small one).
 */
export function diffBaselines(
  a: EngineBaselineSnapshot,
  b: EngineBaselineSnapshot,
  opts: { maxDivergences?: number } = {},
): BaselineDiffResult {
  const maxDivergences = opts.maxDivergences ?? 50;
  const divergences: BaselineDivergence[] = [];

  if (a.healthScore.overall !== b.healthScore.overall) {
    divergences.push({
      ruleId: "(overall)",
      kind: "score-mismatch",
      detail: `overall health score: ${a.healthScore.overall} vs ${b.healthScore.overall}`,
    });
  }
  for (const field of ["errorCount", "warningCount", "passedCount"] as const) {
    if (a.healthScore[field] !== b.healthScore[field]) {
      divergences.push({
        ruleId: "(overall)",
        kind: "score-mismatch",
        detail: `${field}: ${a.healthScore[field]} vs ${b.healthScore[field]}`,
      });
    }
  }
  const catByKeyA = new Map(a.healthScore.categories.map((c) => [c.category, c]));
  const catByKeyB = new Map(b.healthScore.categories.map((c) => [c.category, c]));
  for (const key of new Set([...catByKeyA.keys(), ...catByKeyB.keys()])) {
    const ca = catByKeyA.get(key);
    const cb = catByKeyB.get(key);
    if (!scoreFieldsEqual(ca, cb)) {
      divergences.push({
        ruleId: `(category:${key})`,
        kind: "score-mismatch",
        detail: `category "${key}": ${JSON.stringify(ca)} vs ${JSON.stringify(cb)}`,
      });
    }
  }
  const groupByKeyA = new Map(a.healthScore.groups.map((g) => [g.group, g]));
  const groupByKeyB = new Map(b.healthScore.groups.map((g) => [g.group, g]));
  for (const key of new Set([...groupByKeyA.keys(), ...groupByKeyB.keys()])) {
    const ga = groupByKeyA.get(key);
    const gb = groupByKeyB.get(key);
    if (!scoreFieldsEqual(ga, gb)) {
      divergences.push({
        ruleId: `(group:${key})`,
        kind: "score-mismatch",
        detail: `group "${key}": ${JSON.stringify(ga)} vs ${JSON.stringify(gb)}`,
      });
    }
  }

  const aKeys = new Set(a.findings.map(findingKey));
  const bKeys = new Set(b.findings.map(findingKey));
  for (const f of a.findings) {
    if (!bKeys.has(findingKey(f))) {
      divergences.push({
        ruleId: f.ruleId,
        kind: "finding-only-in-a",
        detail: `${f.checkName} status=${f.status} pageUrl=${f.pageUrl ?? "(site)"} — in A, missing from B`,
      });
    }
  }
  for (const f of b.findings) {
    if (!aKeys.has(findingKey(f))) {
      divergences.push({
        ruleId: f.ruleId,
        kind: "finding-only-in-b",
        detail: `${f.checkName} status=${f.status} pageUrl=${f.pageUrl ?? "(site)"} — in B, missing from A`,
      });
    }
  }

  // JSON.stringify equality is safe here (unlike categories/groups above):
  // RuleTallySnapshot is built exclusively by statusBucket()/buildSnapshot()
  // in this file with a fixed literal key order, never by the engine's own
  // scoring code, so there's no cross-implementation key-order risk to guard
  // against. (missingAltText below does NOT get this treatment — it comes
  // straight from the engine's report.summary, so it gets the same
  // field-by-field comparison as categories/groups instead.)
  const tallyByRuleA = new Map(a.perRuleTally.map((t) => [t.ruleId, t]));
  const tallyByRuleB = new Map(b.perRuleTally.map((t) => [t.ruleId, t]));
  for (const ruleId of new Set([...tallyByRuleA.keys(), ...tallyByRuleB.keys()])) {
    const ta = tallyByRuleA.get(ruleId);
    const tb = tallyByRuleB.get(ruleId);
    if (JSON.stringify(ta) !== JSON.stringify(tb)) {
      divergences.push({
        ruleId,
        kind: "tally-mismatch",
        detail: `tally: ${JSON.stringify(ta)} vs ${JSON.stringify(tb)}`,
      });
    }
  }

  divergences.push(
    ...diffStringArray("missingTitles", a.summary.missingTitles, b.summary.missingTitles),
    ...diffStringArray(
      "missingDescriptions",
      a.summary.missingDescriptions,
      b.summary.missingDescriptions,
    ),
    ...diffStringArray("missingOgTags", a.summary.missingOgTags, b.summary.missingOgTags),
    ...diffStringArray(
      "missingTwitterCards",
      a.summary.missingTwitterCards,
      b.summary.missingTwitterCards,
    ),
    ...diffStringArray("missingSchemas", a.summary.missingSchemas, b.summary.missingSchemas),
    ...diffStringArray("multipleH1s", a.summary.multipleH1s, b.summary.multipleH1s),
    ...diffStringArray("thinContentPages", a.summary.thinContentPages, b.summary.thinContentPages),
    ...diffStringArray("urlIssues", a.summary.urlIssues, b.summary.urlIssues),
    ...diffStringArray("redirectChains", a.summary.redirectChains, b.summary.redirectChains),
    ...diffStringArray("securityIssues", a.summary.securityIssues, b.summary.securityIssues),
  );
  // Field-by-field (not JSON.stringify) for the same reason as categories/
  // groups: these entries are built by the engine's own report generation
  // (packages/audit-engine/src/adapter.ts), not by this module, so a future
  // v2 implementation isn't guaranteed to construct the {page, image}
  // literal with the same key order even if the content is identical.
  const altKey = (entry: { page: string; image: string }) => `${entry.page}\x1f${entry.image}`;
  const altA = new Set(a.summary.missingAltText.map(altKey));
  const altB = new Set(b.summary.missingAltText.map(altKey));
  const altMismatch =
    a.summary.missingAltText.length !== b.summary.missingAltText.length ||
    a.summary.missingAltText.some((e) => !altB.has(altKey(e))) ||
    b.summary.missingAltText.some((e) => !altA.has(altKey(e)));
  if (altMismatch) {
    divergences.push({
      ruleId: "(summary)",
      kind: "summary-mismatch",
      detail: `missingAltText: A has ${a.summary.missingAltText.length} entries, B has ${b.summary.missingAltText.length} entries — ${JSON.stringify(a.summary.missingAltText)} vs ${JSON.stringify(b.summary.missingAltText)}`,
    });
  }

  divergences.sort((x, y) => x.ruleId.localeCompare(y.ruleId));

  return {
    identical: divergences.length === 0,
    divergences: divergences.slice(0, maxDivergences),
    totalDivergences: divergences.length,
  };
}
