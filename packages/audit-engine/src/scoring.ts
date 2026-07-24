// Health Score calculation with dynamic rebalancing
// Scores based ONLY on enabled rules - disabled rules don't affect score

// `/types` not the barrel: the barrel makes a type-only import pull every rule
// module's types, surfacing their linkedom DOM-typing quirks under a consumer's
// tsconfig (e.g. the API Worker). types.ts is the leaf type module. (#195)
import type { RuleRunResult } from "@squirrelscan/rules/types";
import type {
  AuditStatus,
  CheckResult,
  HealthScore,
  CategoryScore,
  GroupScore,
  RuleGroup,
} from "@squirrelscan/core-contracts";
import { getScoreGrade, getScoreColor } from "@squirrelscan/core-contracts/scoring";

import {
  SCORING_CURVE_EXPONENT,
  SCORE_SCALE,
  PENALTY_NO_ROBOTS_TXT,
  PENALTY_ROBOTS_BLOCKS_ALL,
  PENALTY_NO_SITEMAP,
  RULE_ID_ROBOTS_TXT,
  RULE_ID_SITEMAP_EXISTS,
  CHECK_NAME_ROBOTS_DISALLOW,
  CHECK_NAME_ROBOTS_EXISTS,
  CHECK_NAME_SITEMAP_EXISTS,
  ISSUE_PENALTY_THRESHOLD,
  ISSUE_PENALTY_WARNING_WEIGHT,
  ISSUE_PENALTY_FAIL_WEIGHT,
  ISSUE_PENALTY_SCALE,
  ISSUE_PENALTY_MAX,
  ISSUE_PENALTY_ITEM_CAP,
} from "@squirrelscan/utils/constants";
// Import the category-name helper from the `/categories` subpath, NOT the
// `@squirrelscan/rules` barrel: the barrel re-exports every rule module (which
// pull linkedom + node builtins), so importing it here would drag those into
// the API Worker bundle. categories.ts is leaf-clean. (#195)
import {
  type RuleCategory,
  getCategoryName,
  getCategoryGroup,
  getGroupName,
  GROUP_CODES,
} from "@squirrelscan/rules/categories";

// Scoring context - expects RuleRunResult with meta.category
export interface ScoringContext {
  results: Map<string, RuleRunResult>;
}

// ============================================
// SMART AUDITS — UNION SCORING (#110)
// ============================================

/** A carried finding (issue on an un-crawled, still-active page). */
export interface CarriedFinding {
  normalizedUrl: string;
  ruleId: string;
  checkName: string;
  /** "fail" | "warn" — carried findings are always issues, never passes. */
  status: string;
  message: string;
  value?: string | number | null;
  expected?: string | number | null;
  /**
   * JSON `{ items?, details?, pages? }` captured when the finding was first
   * recorded — replayed onto the union check so a carried finding renders with
   * the SAME per-item detail as a fresh one.
   */
  payload?: string | null;
}

/** Minimal rule meta the union scorer needs. */
export interface UnionRuleMeta {
  meta: RuleRunResult["meta"];
}

export interface MergedScoringInput {
  /** Fresh rule results for THIS run (already correct for crawled pages). */
  freshResults: Map<string, RuleRunResult>;
  /** Issues on un-crawled, still-active pages carried forward from the store. */
  carriedFindings: CarriedFinding[];
  /** Normalized URLs of pages carried forward (un-crawled but still active). */
  carriedPageUrls: Set<string>;
  /** ruleId -> meta for rules absent from `freshResults` (carried-only rules). */
  ruleMetaIndex: Map<string, RuleRunResult["meta"]>;
}

/**
 * Build a `Map<ruleId, RuleRunResult>` over the UNION of active pages so a
 * partial re-audit never inflates the score.
 *
 * Strategy: start from the fresh per-page results (correct denominators + pass
 * counts for crawled pages), then for every page-scope rule add, per carried
 * page, either the carried fail/warn check or a synthetic `pass` check. The
 * synthetic passes keep the rule's pass-ratio DENOMINATOR covering the whole
 * union — without them, dropping the clean carried pages would let a partial
 * re-audit drift the score. Carried fails are appended exactly once (carried
 * pages are never in `freshResults`), so there is no double-penalty.
 *
 * Site-scope rules are page-independent — their fresh checks pass through
 * unchanged (a site rule runs over whatever pages this run crawled).
 */
export function buildScoringResultsFromMerged(
  input: MergedScoringInput
): Map<string, RuleRunResult> {
  const { freshResults, carriedFindings, carriedPageUrls, ruleMetaIndex } =
    input;

  // Clone fresh results (don't mutate the caller's map / arrays). Preserve any
  // incoming `syntheticPassCount`: the #1023 complete-store reconstruction folds
  // fresh crawled-clean pages into it (rather than materializing pass checks),
  // and the carried-clean count below ADDS to it. Normal (sample) callers never
  // set it, so this is a no-op there.
  const union = new Map<string, RuleRunResult>();
  for (const [ruleId, result] of freshResults) {
    union.set(ruleId, {
      meta: result.meta,
      checks: [...result.checks],
      ...(result.syntheticPassCount !== undefined
        ? { syntheticPassCount: result.syntheticPassCount }
        : {}),
    });
  }

  // Index carried findings by (ruleId -> normalizedUrl -> findings).
  const carriedByRule = new Map<string, Map<string, CarriedFinding[]>>();
  for (const f of carriedFindings) {
    let byUrl = carriedByRule.get(f.ruleId);
    if (!byUrl) {
      byUrl = new Map();
      carriedByRule.set(f.ruleId, byUrl);
    }
    const list = byUrl.get(f.normalizedUrl) ?? [];
    list.push(f);
    byUrl.set(f.normalizedUrl, list);
  }

  // Every page-scope rule that exists this run OR carried a finding applies to
  // the full carried-page set (page rules run on every page).
  const pageScopeRuleIds = new Set<string>();
  for (const [ruleId, result] of union) {
    if (result.meta.scope === "page") pageScopeRuleIds.add(ruleId);
  }
  for (const ruleId of carriedByRule.keys()) {
    const meta = union.get(ruleId)?.meta ?? ruleMetaIndex.get(ruleId);
    if (meta?.scope === "page") pageScopeRuleIds.add(ruleId);
  }

  for (const ruleId of pageScopeRuleIds) {
    let result = union.get(ruleId);
    if (!result) {
      const meta = ruleMetaIndex.get(ruleId);
      if (!meta) continue; // unknown rule — skip rather than fabricate scoring
      result = { meta, checks: [] };
      union.set(ruleId, result);
    }
    const carriedForRule = carriedByRule.get(ruleId);
    // Replay EVERY carried finding for this rule, regardless of whether its page
    // is in `carriedPageUrls`. A carried finding is an active open finding on a
    // known page; its inclusion in the union must not depend on the page being
    // un-crawled. Pre-#1167 every carried finding sat on an un-crawled page (⊆
    // carriedPageUrls), so this was equivalent to the old carriedPageUrls-gated
    // replay — but #1167 publish page-sampling can carry a finding on a page that
    // WAS crawled (still failing, but clipped out of the check's page sample). If
    // the replay were gated on carriedPageUrls (which excludes crawled pages) that
    // finding would persist open in storage yet vanish from the union score,
    // report, and issue-sync — re-inflating exactly the score #1167 protects.
    if (carriedForRule) {
      for (const [url, findings] of carriedForRule) {
        for (const f of findings) {
          // Replay the captured payload (items/details/pages) so carried
          // findings render with the same per-item detail as fresh ones.
          const payload = parseCarriedPayload(f.payload);
          result.checks.push({
            name: f.checkName,
            status: f.status === "fail" ? "fail" : "warn",
            message: f.message,
            pageUrl: url,
            value: f.value ?? undefined,
            expected: f.expected ?? undefined,
            ...(payload.items ? { items: payload.items } : {}),
            ...(payload.details ? { details: payload.details } : {}),
            ...(payload.pages ? { pages: payload.pages } : {}),
          });
        }
      }
    }
    // Clean carried pages — carried pages with NO finding for this rule count
    // toward the pass-ratio DENOMINATOR. Folded to a count (not one synthetic
    // "pass" CheckResult per page) so a partial re-audit of a large site can't
    // materialize (page-scope rules × thousands of carried pages) pass objects and
    // OOM the Worker (#918). calculateHealthScore adds syntheticPassCount to
    // passed+total. Only carriedPageUrls (un-crawled active pages) are eligible —
    // a crawled page's pass/fail is already counted by its fresh (or replayed
    // carried) check, so it must not also count here.
    let cleanCarriedPasses = 0;
    for (const url of carriedPageUrls) {
      const findings = carriedForRule?.get(url);
      if (!findings || findings.length === 0) cleanCarriedPasses++;
    }
    // ADD to any fresh-clean count the reconstruction stamped (#1023), rather
    // than overwrite — a complete-store re-audit has BOTH fresh crawled-clean
    // passes and carried-clean passes, and the union denominator must count both.
    const totalSyntheticPasses = (result.syntheticPassCount ?? 0) + cleanCarriedPasses;
    if (totalSyntheticPasses > 0) result.syntheticPassCount = totalSyntheticPasses;
  }

  return union;
}

interface CarriedPayload {
  items?: CheckResult["items"];
  details?: CheckResult["details"];
  pages?: CheckResult["pages"];
}

/** Safely parse a carried finding's stored payload JSON. */
function parseCarriedPayload(payload?: string | null): CarriedPayload {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as CarriedPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function groupResultsByCategory(
  results: Map<string, RuleRunResult>
): Map<string, RuleRunResult[]> {
  const groups = new Map<string, RuleRunResult[]>();
  for (const result of results.values()) {
    const category = result.meta.category;
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(result);
  }
  return groups;
}

// Calculate earned weight for a rule's checks
// Returns -1 for fully-skipped rules (should be excluded from scoring)
// `advisory` (severity "info" rules): warn checks surface in the report as
// recommendations but are score-neutral — only fails count against the score.
// `syntheticPasses` (#918): carried-clean passes counted, not materialized.
function calculateRuleScore(checks: CheckResult[], advisory = false, syntheticPasses = 0): number {
  // no checks AND no carried-clean passes = exclude from scoring
  if (checks.length === 0 && syntheticPasses === 0) return -1;

  let passed = 0;
  let total = 0;

  for (const check of checks) {
    // Skipped and info checks don't count toward score
    if (check.status === "skipped" || check.status === "info") continue;
    if (advisory && check.status === "warn") continue;

    total++;
    if (check.status === "pass") {
      passed += 1;
    } else if (check.status === "warn") {
      passed += 0.5; // warnings count as half
    }
    // fail = 0
  }

  // Carried-clean synthetic passes (#918): counted, not materialized — each is
  // one ordinary pass on a clean carried page (+1 passed, +1 total). Equivalent
  // to pushing N "carried (clean)" pass checks, without the per-page objects.
  passed += syntheticPasses;
  total += syntheticPasses;

  // If only skipped/info checks (and no synthetic passes), exclude from scoring
  return total > 0 ? passed / total : -1;
}

// Apply scoring curve to compress high scores
// Scores are normalized to 0-1 range, curved via exponential function, then scaled back to SCORE_SCALE
function applyScoringCurve(baseScore: number): number {
  const normalized = baseScore / SCORE_SCALE; // Normalize to 0-1 range
  const curved = Math.pow(normalized, SCORING_CURVE_EXPONENT);
  return Math.round(curved * SCORE_SCALE); // Scale back to SCORE_SCALE range
}

// Per-bucket issue tally: check-level counts (for display / roll-up) plus
// item-aware issue UNITS (for the density penalty). warnUnits/failUnits equal
// warnings/failed when no check carries `items[]`, so behavior is unchanged
// for item-less checks. (#683)
// Exported (#1021) so the streaming rules loop can fold per-page results into
// per-rule tallies with the EXACT same item-aware math, then score from those
// tallies via `calculateHealthScoreFromTallies` — byte-identical to scoring the
// fully-materialized checks array. Item semantics documented on addChecksToTally.
export interface IssueTally {
  passed: number;
  warnings: number;
  failed: number;
  warnUnits: number;
  failUnits: number;
}

export function emptyTally(): IssueTally {
  return { passed: 0, warnings: 0, failed: 0, warnUnits: 0, failUnits: 0 };
}

// Add ONE rule's checks to a tally.
//
// FAIL units are item-aware: a failed check contributes its `items[]` count
// (e.g. 50 unnamed buttons on a page), floored at 1, capped per
// (checkName, pageUrl) GROUP by ISSUE_PENALTY_ITEM_CAP — not per check — so one
// pathological page can't zero a bucket AND a fresh multi-item check caps
// identically to its smart-audit carried form, which `flattenChecks` explodes
// into one finding row per item and `buildScoringResultsFromMerged` replays as
// one check per item. That keeps a partial re-audit's score in lockstep with
// the full audit. (#683)
//
// WARN units are check-level (one distinct (checkName, pageUrl) = 1 unit,
// regardless of item volume): the #683 complaint is about ERRORS reading green;
// making warnings item-aware let a single many-item warning (e.g. CSP hints on
// every page) drag a zero-error category to red. Distinct-key counting (not raw
// check counting) keeps the same carried-form symmetry as fails.
//
// Most rules truncate `items` to ~10 and record the true remainder as
// `details.additional` (e.g. button-name: 50 unnamed buttons → 10 items +
// additional: 40), so units must include it or a11y-heavy pages — the exact
// family behind #683 — undercount. `additional` is summed as a per-key MAX,
// not per check: the carried form replays one row per item, each copying the
// ORIGINAL check's details, so summing would count the remainder once per row
// while the fresh form counts it once.
//
// Called once per rule, so keys are naturally rule-scoped (no cross-rule
// checkName collisions).
function checkAdditional(check: CheckResult): number {
  const extra = check.details?.additional;
  return typeof extra === "number" && Number.isFinite(extra) && extra > 0
    ? Math.floor(extra)
    : 0;
}

// `advisory` mirrors calculateRuleScore: warn checks in severity-"info" rules
// are recommendations — kept out of warning counts and the density penalty.
// `syntheticPasses` (#918): carried-clean passes bump the pass tally by count.
export function addChecksToTally(
  tally: IssueTally,
  checks: CheckResult[],
  advisory = false,
  syntheticPasses = 0
): void {
  const failUnitsByKey = new Map<string, number>();
  const failExtraByKey = new Map<string, number>();
  const warnKeys = new Set<string>();
  for (const check of checks) {
    if (advisory && check.status === "warn") continue;
    if (check.status === "pass") {
      tally.passed++;
    } else if (check.status === "warn" || check.status === "fail") {
      // NUL delimiter: cannot appear in a check name or URL, so pairs never collide.
      const key = `${check.name}\u0000${check.pageUrl ?? ""}`;
      const units = Math.max(check.items?.length ?? 0, 1);
      if (check.status === "warn") {
        tally.warnings++;
        warnKeys.add(key);
      } else {
        tally.failed++;
        failUnitsByKey.set(key, (failUnitsByKey.get(key) ?? 0) + units);
        const extra = checkAdditional(check);
        if (extra > 0) {
          failExtraByKey.set(
            key,
            Math.max(failExtraByKey.get(key) ?? 0, extra)
          );
        }
      }
    }
    // "skipped" and "info" don't count toward totals
  }
  tally.warnUnits += warnKeys.size;
  for (const [key, units] of failUnitsByKey) {
    tally.failUnits += Math.min(
      units + (failExtraByKey.get(key) ?? 0),
      ISSUE_PENALTY_ITEM_CAP
    );
  }
  // Carried-clean synthetic passes (#918): each is one pass, so bump the pass
  // tally by the count — equivalent to N "carried (clean)" pass checks.
  tally.passed += syntheticPasses;
}

export function addTally(target: IssueTally, source: IssueTally): void {
  target.passed += source.passed;
  target.warnings += source.warnings;
  target.failed += source.failed;
  target.warnUnits += source.warnUnits;
  target.failUnits += source.failUnits;
}

/**
 * Per-rule pass ratio derived from a folded {@link IssueTally}, byte-identical to
 * {@link calculateRuleScore}(checks, advisory, synthetic). Synthetic passes are
 * already baked into `tally.passed` by addChecksToTally, and advisory `warn`s are
 * already excluded there, so this needs no advisory flag: numerator = passed +
 * 0.5·warnings, denominator = passed + warnings + failed, and `-1` (exclude from
 * scoring) when the denominator is 0.
 */
export function ruleScoreFromTally(tally: IssueTally): number {
  const total = tally.passed + tally.warnings + tally.failed;
  if (total === 0) return -1;
  return (tally.passed + 0.5 * tally.warnings) / total;
}

// Internal result type that includes weight metadata for overall score calculation
interface CategoryScoreResult {
  categoryScore: CategoryScore;
  totalWeight: number;
  earnedWeight: number;
  // Item-aware tally, exposed so the group roll-up can compute its own
  // density penalty from local counts. (#683)
  tally: IssueTally;
}

function calculateCategoryScoreFromResults(
  category: RuleCategory,
  ruleResults: RuleRunResult[]
): CategoryScoreResult | null {
  let totalWeight = 0;
  let earnedWeight = 0;
  const tally = emptyTally();

  for (const { meta, checks, syntheticPassCount } of ruleResults) {
    const advisory = meta.severity === "info";
    // #918: carried-clean passes ride as a count, not per-page objects.
    const synthetic = syntheticPassCount ?? 0;
    const passRate = calculateRuleScore(checks, advisory, synthetic);
    // Skip fully-skipped rules (passRate === -1)
    if (passRate === -1) continue;

    totalWeight += meta.weight;
    earnedWeight += meta.weight * passRate;
    addChecksToTally(tally, checks, advisory, synthetic);
  }

  // Return null for non-applicable categories
  if (totalWeight === 0) {
    return null;
  }

  const baseScore = (earnedWeight / totalWeight) * SCORE_SCALE;
  const curved = applyScoringCurve(baseScore);

  // Item-aware issue-density penalty per category (#683). Previously penalties
  // were site-level only, so a category could read green while carrying many
  // element-level errors; now it uses the category's LOCAL item-aware counts,
  // keeping category / group / overall mutually consistent.
  const { multiplier } = calculateIssueDensityPenalty(
    tally.passed,
    tally.warnUnits,
    tally.failUnits
  );
  const score = Math.round(curved * multiplier);

  return {
    categoryScore: {
      category,
      name: "", // Will be set by caller from CATEGORY_METADATA
      score,
      passed: tally.passed,
      warnings: tally.warnings,
      failed: tally.failed,
      total: tally.passed + tally.warnings + tally.failed,
    },
    totalWeight,
    earnedWeight,
    tally,
  };
}

// Calculate penalty multiplier for critical crawl failures
// Returns a multiplier (0-1) to apply to the curved score
// Penalties are applied multiplicatively - each reduces the remaining score
// Example: 80% score with robots.txt missing (15%) and no sitemap (20%):
//   80 × (1 - 0.15) × (1 - 0.20) = 80 × 0.85 × 0.80 = 54.4
//
// Graceful degradation: If rules or checks don't exist (e.g., rules disabled or renamed),
// penalties simply don't apply (multiplier stays at 1.0). This is intentional - we don't
// want to fail scoring if rules change. The constants prevent accidental silent failures
// from typos, while allowing intentional structural changes.
//
// This function depends on rule implementation behavior:
//   - robots-txt rule returns early when file is missing, creating only an 'exists' check
//   - When robots.txt exists but blocks all, both 'exists' and 'disallow' checks are created
function calculatePenaltyMultiplier(
  results: Map<string, RuleRunResult>
): number {
  let multiplier = 1.0; // Start with no penalty

  // Check robots.txt rule - gracefully handles missing rule/checks
  const robotsRule = results.get(RULE_ID_ROBOTS_TXT);
  if (robotsRule) {
    const disallowCheck = robotsRule.checks.find(
      (c) => c.name === CHECK_NAME_ROBOTS_DISALLOW
    );
    const existsCheck = robotsRule.checks.find(
      (c) => c.name === CHECK_NAME_ROBOTS_EXISTS
    );

    // These are independent checks - both penalties can apply multiplicatively
    if (disallowCheck?.status === "fail") {
      multiplier *= 1 - PENALTY_ROBOTS_BLOCKS_ALL; // Blocks all
    }
    if (existsCheck?.status === "warn") {
      multiplier *= 1 - PENALTY_NO_ROBOTS_TXT; // Missing
    }
  }

  // Check sitemap rule using constants to prevent silent failures
  const sitemapRule = results.get(RULE_ID_SITEMAP_EXISTS);
  if (sitemapRule) {
    const existsCheck = sitemapRule.checks.find(
      (c) => c.name === CHECK_NAME_SITEMAP_EXISTS
    );
    if (existsCheck?.status === "fail") {
      multiplier *= 1 - PENALTY_NO_SITEMAP; // Missing
    }
  }

  return multiplier;
}

// Item-aware issue-density penalty (#683). Inputs are item-aware issue UNITS
// (see addChecksToTally) rather than raw check counts, so 100 element-level
// errors weigh ~100 — not the ~3-5 failed checks that carry them. Applied to
// the overall score AND to each group/category using that bucket's local units,
// with a per-check item cap upstream so one page can't dominate. Reduces to the
// pre-#683 check-level behavior when no check carries `items[]`.
function calculateIssueDensityPenalty(
  passed: number,
  warnUnits: number,
  failUnits: number
): { multiplier: number; deduction: number } {
  const totalIssueUnits = warnUnits + failUnits;
  const totalUnits = passed + warnUnits + failUnits;

  if (totalIssueUnits < ISSUE_PENALTY_THRESHOLD || totalUnits === 0) {
    return { multiplier: 1, deduction: 0 };
  }

  const weightedIssues =
    failUnits * ISSUE_PENALTY_FAIL_WEIGHT +
    warnUnits * ISSUE_PENALTY_WARNING_WEIGHT;
  const density = weightedIssues / totalUnits;
  const penalty = Math.min(ISSUE_PENALTY_MAX, density * ISSUE_PENALTY_SCALE);

  return { multiplier: 1 - penalty, deduction: penalty };
}

/** Crawl-outcome signals used to decide whether a real audit happened (#489). */
export interface AuditStatusSignals {
  /** Total pages the crawler produced for this run. */
  pagesCrawled: number;
  /** Pages that returned fetchable content (final status 2xx). */
  contentPages: number;
  /**
   * Pages whose final status means the site actively refused the crawler —
   * auth/bot-wall/rate-limit (401, 403, 429). NOT 503 (server-unavailable →
   * `failed`). Used only to distinguish a `blocked` site from a `failed`
   * (unreachable/unavailable) one when there is no content.
   */
  blockedPages: number;
  /**
   * Blocked/rate-limited fetches (403/429) that failed BEFORE any page record
   * was stored — the most common block shape is the ROOT page getting walled,
   * which fails the fetch so no 403 page exists and `pagesCrawled` is 0. Sourced
   * from crawl stats (`pagesBlocked`, #792). Optional/backward-compatible: absent
   * ⇒ treated as 0, preserving the pre-#792 pages-only behavior.
   */
  blockedErrors?: number;
}

/**
 * Derive an {@link AuditStatus} from crawl outcome so a down/403/0-page site
 * doesn't publish a fake "A / 100%". Returns `completed` for a normal run; the
 * caller only stamps the report when status !== "completed". `partial` is left
 * for the render-block fallback / smart-audits paths to set.
 */
export function deriveAuditStatus(s: AuditStatusSignals): {
  status: AuditStatus;
  reason?: string;
} {
  const BLOCKED_REASON =
    "Site blocked the crawler (bot protection / auth / rate limit)";
  // A refusal shows up either as a stored 401/403/429 page OR as a 403/429 fetch
  // that failed before any page was stored (walled root, #792). Either means the
  // site actively blocked us, not that it was unreachable.
  const blocked = s.blockedPages + (s.blockedErrors ?? 0);
  if (s.pagesCrawled === 0) {
    return blocked > 0
      ? { status: "blocked", reason: BLOCKED_REASON }
      : { status: "failed", reason: "No pages were crawled" };
  }
  if (s.contentPages === 0) {
    return blocked > 0
      ? { status: "blocked", reason: BLOCKED_REASON }
      : { status: "failed", reason: "Site unreachable, no pages could be fetched" };
  }
  return { status: "completed" };
}

/**
 * Derive the audit status straight from stored page records — the single source
 * of the 0-page/403/all-error detection shared by the CLI report path
 * (`reconstruct.ts`) AND the cloud/live report builder (`generateReportFromStorage`).
 * Only `status` is read; 2xx = content (the crawler follows redirects, so a
 * stored 3xx is an unfollowed hop, not content), 401/403/429 = active refusal.
 *
 * `blockedErrors` (crawl stats `pagesBlocked`) covers 403/429 fetches that
 * failed before a page was stored — the walled-root case where `pages` is empty
 * (#792). Defaults to 0 so callers without stats keep the pages-only behavior.
 */
export function deriveAuditStatusFromPages(
  pages: readonly { status: number }[],
  blockedErrors = 0
): {
  status: AuditStatus;
  reason?: string;
} {
  return deriveAuditStatus({
    pagesCrawled: pages.length,
    contentPages: pages.filter((p) => p.status >= 200 && p.status < 300).length,
    blockedPages: pages.filter(
      (p) => p.status === 401 || p.status === 403 || p.status === 429
    ).length,
    blockedErrors,
  });
}

// Main scoring function - only scores enabled rules
export function calculateHealthScore(ctx: ScoringContext): HealthScore {
  const { results } = ctx;

  // No rules ran (0 pages, or every page errored/was blocked) ⇒ no audit
  // happened. Must NOT read as a perfect 100/A — the caller surfaces the
  // failure via AuditReport.status; the score itself is null / N-A (#586,
  // was 0 in #489 — 0 read as "audited, scored zero"; null = "no score").
  if (results.size === 0) {
    return {
      overall: null,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 0,
      debug: {
        base: 0,
        curved: 0,
        penalties: 0,
      },
    };
  }

  const categoryResults = groupResultsByCategory(results);

  const categories: CategoryScore[] = [];
  let totalWeight = 0;
  let earnedWeight = 0;
  const overallTally = emptyTally();

  // Group-level roll-up (#626): the same weighted bookkeeping as categories,
  // bucketed by each category's top-level group. Scored like a category
  // (pass-ratio + curve + the item-aware issue-density penalty from local
  // counts, #683 — previously site-level only, which let a group read green
  // while carrying many element-level errors).
  const groupAgg = new Map<
    RuleGroup,
    { totalWeight: number; earnedWeight: number; tally: IssueTally }
  >();

  for (const [category, ruleResultsInCategory] of categoryResults) {
    const result = calculateCategoryScoreFromResults(
      category as RuleCategory,
      ruleResultsInCategory
    );

    // Skip non-applicable categories (no weight)
    if (result === null) {
      continue;
    }

    // Use the precomputed weights from category calculation
    totalWeight += result.totalWeight;
    earnedWeight += result.earnedWeight;

    // Set category name from metadata (category already set in calculateCategoryScoreFromResults)
    result.categoryScore.name = getCategoryName(result.categoryScore.category);
    categories.push(result.categoryScore);

    addTally(overallTally, result.tally);

    // Roll the same weights + item-aware tally up into the category's group.
    const group = getCategoryGroup(result.categoryScore.category);
    const agg =
      groupAgg.get(group) ??
      { totalWeight: 0, earnedWeight: 0, tally: emptyTally() };
    agg.totalWeight += result.totalWeight;
    agg.earnedWeight += result.earnedWeight;
    addTally(agg.tally, result.tally);
    groupAgg.set(group, agg);
  }

  // Emit groups in canonical display order (GROUP_CODES), skipping groups with
  // no applicable rules — same "no weight ⇒ omit" rule as categories.
  const groups: GroupScore[] = [];
  for (const group of GROUP_CODES) {
    const agg = groupAgg.get(group);
    if (!agg || agg.totalWeight === 0) continue;
    const groupBase = (agg.earnedWeight / agg.totalWeight) * SCORE_SCALE;
    const groupCurved = applyScoringCurve(groupBase);
    // Same item-aware density penalty as categories/overall, on local counts.
    const { multiplier: groupMultiplier } = calculateIssueDensityPenalty(
      agg.tally.passed,
      agg.tally.warnUnits,
      agg.tally.failUnits
    );
    groups.push({
      group,
      name: getGroupName(group),
      score: Math.round(groupCurved * groupMultiplier),
      passed: agg.tally.passed,
      warnings: agg.tally.warnings,
      failed: agg.tally.failed,
      total: agg.tally.passed + agg.tally.warnings + agg.tally.failed,
    });
  }

  // Sort by error count (most errors first), then warnings, then score
  // Perfect categories (100%, no issues) shown last for positive feedback
  categories.sort((a, b) => {
    const aPerfect = a.score === 100 && a.failed === 0 && a.warnings === 0;
    const bPerfect = b.score === 100 && b.failed === 0 && b.warnings === 0;

    // Perfect categories go last
    if (aPerfect && !bPerfect) return 1;
    if (!aPerfect && bPerfect) return -1;

    // Most errors first
    if (a.failed !== b.failed) {
      return b.failed - a.failed;
    }

    // Same errors: most warnings first
    if (a.warnings !== b.warnings) {
      return b.warnings - a.warnings;
    }

    // Same errors and warnings: lowest score first
    return a.score - b.score;
  });

  // `totalWeight === 0` here means rules DID run but every applicable check was
  // skipped/info (an issue-free audit) ⇒ full score, as before. The genuine "no
  // audit happened" case (down/403/0-page) is caught by the empty-results guard
  // above (→ 0) and surfaced via AuditReport.status (#489).
  const baseScore =
    totalWeight > 0 ? (earnedWeight / totalWeight) * SCORE_SCALE : SCORE_SCALE;

  // Apply curve to compress high scores
  const curvedScore = applyScoringCurve(baseScore);

  // Apply proportional penalties for critical failures
  const penaltyMultiplier = calculatePenaltyMultiplier(results);
  const { multiplier: issuePenaltyMultiplier, deduction: issuePenalty } =
    calculateIssueDensityPenalty(
      overallTally.passed,
      overallTally.warnUnits,
      overallTally.failUnits
    );

  const overall = Math.round(
    curvedScore * penaltyMultiplier * issuePenaltyMultiplier
  );

  const penaltyFromCritical = curvedScore * (1 - penaltyMultiplier);
  const penaltyFromIssues =
    curvedScore * penaltyMultiplier * (1 - issuePenaltyMultiplier);

  return {
    overall,
    categories,
    groups,
    errorCount: overallTally.failed,
    warningCount: overallTally.warnings,
    passedCount: overallTally.passed,
    debug: {
      base: Math.round(baseScore),
      curved: curvedScore,
      penalties: Math.round(penaltyFromCritical + penaltyFromIssues), // Show as point deduction for readability
      issuePenalty: Math.round(penaltyFromIssues),
      issueDensity: Number((issuePenalty * 100).toFixed(1)),
    },
  };
}

// A per-rule folded tally + its meta — the streaming loop's replacement for a
// per-rule RuleRunResult once the checks array has been folded away (#1021).
export interface RuleTally {
  meta: RuleRunResult["meta"];
  tally: IssueTally;
}

/**
 * Fold one rule's per-page (or site) result into the running per-rule tally map
 * (#1021). Incremental folding is byte-identical to `addChecksToTally` over the
 * fully-concatenated per-rule checks array because the item-aware keys are
 * `${name} ${pageUrl}` and page-rule checks are stamped with their page's
 * URL before folding — so every (name,pageUrl) bucket is confined to a single
 * fold call and the per-key sums/max/distinct-counts add up identically across
 * calls. Mirrors mergeRuleRunResult's "meta from first insert" semantics.
 */
export function foldRuleResultIntoTallies(
  tallies: Map<string, RuleTally>,
  ruleId: string,
  result: RuleRunResult
): void {
  let entry = tallies.get(ruleId);
  if (!entry) {
    entry = { meta: result.meta, tally: emptyTally() };
    tallies.set(ruleId, entry);
  }
  const advisory = result.meta.severity === "info";
  addChecksToTally(
    entry.tally,
    result.checks,
    advisory,
    result.syntheticPassCount ?? 0
  );
}

/**
 * Health score from PRE-FOLDED per-rule tallies (#1021). Byte-identical twin of
 * {@link calculateHealthScore}: it reproduces the exact category → group →
 * overall weighting, curve, item-aware density penalties, category sort, and
 * debug fields, deriving each rule's pass ratio from its tally via
 * {@link ruleScoreFromTally} and merging tallies with {@link addTally} instead of
 * re-scanning checks. The GOLDEN INVARIANT (streaming-golden test): for any run,
 * folding page/site checks into these tallies then calling this === calling
 * calculateHealthScore over the fully-materialized checks map.
 *
 * `penaltyResults` carries ONLY the rules the critical robots/sitemap penalty
 * reads ({@link RULE_ID_ROBOTS_TXT}, {@link RULE_ID_SITEMAP_EXISTS}) with their
 * real checks — they are site rules with O(1) checks, so keeping them is free and
 * lets {@link calculatePenaltyMultiplier} run verbatim (the penalty reads named
 * check statuses a tally cannot carry).
 */
export function calculateHealthScoreFromTallies(
  tallies: Map<string, RuleTally>,
  penaltyResults: Map<string, RuleRunResult>
): HealthScore {
  if (tallies.size === 0) {
    return {
      overall: null,
      categories: [],
      groups: [],
      errorCount: 0,
      warningCount: 0,
      passedCount: 0,
      debug: { base: 0, curved: 0, penalties: 0 },
    };
  }

  // Bucket rule tallies by category (mirrors groupResultsByCategory).
  const byCategory = new Map<RuleCategory, RuleTally[]>();
  for (const rt of tallies.values()) {
    const category = rt.meta.category as RuleCategory;
    const list = byCategory.get(category);
    if (list) list.push(rt);
    else byCategory.set(category, [rt]);
  }

  const categories: CategoryScore[] = [];
  let totalWeight = 0;
  let earnedWeight = 0;
  const overallTally = emptyTally();
  const groupAgg = new Map<
    RuleGroup,
    { totalWeight: number; earnedWeight: number; tally: IssueTally }
  >();

  for (const [category, ruleTallies] of byCategory) {
    let catTotalWeight = 0;
    let catEarnedWeight = 0;
    const catTally = emptyTally();

    for (const { meta, tally } of ruleTallies) {
      const passRate = ruleScoreFromTally(tally);
      if (passRate === -1) continue; // fully skipped/info rule — exclude
      catTotalWeight += meta.weight;
      catEarnedWeight += meta.weight * passRate;
      addTally(catTally, tally);
    }

    if (catTotalWeight === 0) continue; // non-applicable category

    const baseScore = (catEarnedWeight / catTotalWeight) * SCORE_SCALE;
    const curved = applyScoringCurve(baseScore);
    const { multiplier } = calculateIssueDensityPenalty(
      catTally.passed,
      catTally.warnUnits,
      catTally.failUnits
    );
    categories.push({
      category,
      name: getCategoryName(category),
      score: Math.round(curved * multiplier),
      passed: catTally.passed,
      warnings: catTally.warnings,
      failed: catTally.failed,
      total: catTally.passed + catTally.warnings + catTally.failed,
    });

    totalWeight += catTotalWeight;
    earnedWeight += catEarnedWeight;
    addTally(overallTally, catTally);

    const group = getCategoryGroup(category);
    const agg =
      groupAgg.get(group) ??
      { totalWeight: 0, earnedWeight: 0, tally: emptyTally() };
    agg.totalWeight += catTotalWeight;
    agg.earnedWeight += catEarnedWeight;
    addTally(agg.tally, catTally);
    groupAgg.set(group, agg);
  }

  const groups: GroupScore[] = [];
  for (const group of GROUP_CODES) {
    const agg = groupAgg.get(group);
    if (!agg || agg.totalWeight === 0) continue;
    const groupBase = (agg.earnedWeight / agg.totalWeight) * SCORE_SCALE;
    const groupCurved = applyScoringCurve(groupBase);
    const { multiplier: groupMultiplier } = calculateIssueDensityPenalty(
      agg.tally.passed,
      agg.tally.warnUnits,
      agg.tally.failUnits
    );
    groups.push({
      group,
      name: getGroupName(group),
      score: Math.round(groupCurved * groupMultiplier),
      passed: agg.tally.passed,
      warnings: agg.tally.warnings,
      failed: agg.tally.failed,
      total: agg.tally.passed + agg.tally.warnings + agg.tally.failed,
    });
  }

  categories.sort((a, b) => {
    const aPerfect = a.score === 100 && a.failed === 0 && a.warnings === 0;
    const bPerfect = b.score === 100 && b.failed === 0 && b.warnings === 0;
    if (aPerfect && !bPerfect) return 1;
    if (!aPerfect && bPerfect) return -1;
    if (a.failed !== b.failed) return b.failed - a.failed;
    if (a.warnings !== b.warnings) return b.warnings - a.warnings;
    return a.score - b.score;
  });

  const baseScore =
    totalWeight > 0 ? (earnedWeight / totalWeight) * SCORE_SCALE : SCORE_SCALE;
  const curvedScore = applyScoringCurve(baseScore);
  const penaltyMultiplier = calculatePenaltyMultiplier(penaltyResults);
  const { multiplier: issuePenaltyMultiplier, deduction: issuePenalty } =
    calculateIssueDensityPenalty(
      overallTally.passed,
      overallTally.warnUnits,
      overallTally.failUnits
    );

  const overall = Math.round(
    curvedScore * penaltyMultiplier * issuePenaltyMultiplier
  );
  const penaltyFromCritical = curvedScore * (1 - penaltyMultiplier);
  const penaltyFromIssues =
    curvedScore * penaltyMultiplier * (1 - issuePenaltyMultiplier);

  return {
    overall,
    categories,
    groups,
    errorCount: overallTally.failed,
    warningCount: overallTally.warnings,
    passedCount: overallTally.passed,
    debug: {
      base: Math.round(baseScore),
      curved: curvedScore,
      penalties: Math.round(penaltyFromCritical + penaltyFromIssues),
      issuePenalty: Math.round(penaltyFromIssues),
      issueDensity: Number((issuePenalty * 100).toFixed(1)),
    },
  };
}

// Score → grade/color thresholds live once in core-contracts; re-export the
// display helpers so audit-engine (and the CLI, which re-exports from here)
// share the canonical scheme. Imported (not `export ... from`) because
// formatHealthScore below needs getScoreGrade in local scope.
export { getScoreGrade, getScoreColor };

export function formatHealthScore(score: HealthScore): string {
  const lines: string[] = [];

  lines.push(
    score.overall === null
      ? "Health Score: N/A (no auditable pages)"
      : `Health Score: ${score.overall}/100 (${getScoreGrade(score.overall)})`
  );
  lines.push("");

  if (score.categories.length > 0) {
    lines.push("Category Breakdown:");
    lines.push("-".repeat(50));

    for (const cat of score.categories) {
      const bar =
        "█".repeat(Math.floor(cat.score / 10)) +
        "░".repeat(10 - Math.floor(cat.score / 10));
      lines.push(`${cat.name.padEnd(20)} ${bar} ${cat.score}%`);
      lines.push(
        `  Passed: ${cat.passed} | Warnings: ${cat.warnings} | Failed: ${cat.failed}`
      );
    }

    lines.push("");
  }

  lines.push(
    `Total: ${score.passedCount} passed, ${score.warningCount} warnings, ${score.errorCount} errors`
  );

  return lines.join("\n");
}
