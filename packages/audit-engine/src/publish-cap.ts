// One capper for every published report (squirrelscan/repo#2656).
//
// A published report is a SUMMARY by design: whatever fires and whatever the
// crawl size, the whole body fits PUBLISHED_REPORT_MAX_BYTES minus the envelope.
// The scoring transport that grows with pages crawled (the compact resolution
// signal and `pageStatuses`) is built to its own fixed share
// (RESOLUTION_PUBLISH_LIMITS, repo#2658), and the rest of the report gets the
// rest. Both publish producers build their body here (repo#2667: the CLI's
// `slimForPublish`, and the cloud container's publish), so the two cannot
// drift, and the API can run the same function over a body from a client that
// predates it.
//
// In order:
//  1. Count what sampling is about to throw away, from the FULL report:
//     `checkTallies` (this run's fresh checks per rule and check name, in the
//     scorer's own units), `linkTargetSets` (every target each link rule
//     lists broken or unverifiable, as hashes, repo#2861), and build the
//     scoring transport: the compact resolution signal and `pageStatuses`,
//     together within their byte share.
//  2. Fold every rule's issue classes ONCE, one aggregate per (check name,
//     status, provenance, foldKey), and drop the per-page pass rows (their
//     counts are in the tallies). Folding once matters: `foldGroup` appends
//     "(+N more pages)", so folding an aggregate again stacks the suffix.
//     Each class's page sample leads with the page it hits hardest, and its
//     items are ranked by how many pages they are on. Top-level `siteChecks`
//     entries that repeat a site check of `ruleResults` are left out. A rule
//     whose classes reach pages its largest class does not gets its distinct
//     page count in `rulePageCounts` (repo#2935).
//  3. Sample each class at REPORT_CAPS.tiers[0] and measure. Over budget, fill
//     breadth first: every class gets a counts row, then a small sample, then
//     the full one, highest priority first, while the budget lasts. If the
//     counts rows alone do not fit, the display sections go to their minimum
//     and the entity map is dropped, and the fill runs again. Last, counts rows
//     are admitted by byte budget. That fits by construction, so the only
//     refusal is a report whose skeleton alone (score, rule meta, tallies,
//     enrichment sections) is over budget: a typed error naming its sections.
//  4. Measure the finished body, transport included, and refuse it with the
//     same typed error if it is somehow still over. Never expected: it is the
//     invariant, checked rather than assumed.
//
// Deterministic (same input, byte-identical output, so the publish content
// hash is stable) and never mutates its input.
//
// Worker-clean: core-contracts, rules/fold, rules/resolution, utils, the
// scorer's tally math and the server's reading of a published check only.

import type {
  CheckItem,
  CheckResult,
  CheckTallies,
  CheckTally,
  LinkTargetSets,
  PublishedReportDetail,
  ResolutionSignal,
  RuleMetaLite,
} from "@squirrelscan/core-contracts";
import {
  LINK_COVERAGE_DETAIL_KEYS,
  LINK_TARGET_SET_RULES,
  NOT_CHECKED_SKIP_REASONS,
} from "@squirrelscan/core-contracts";
import type { CompactResolutionSignal } from "@squirrelscan/core-contracts/resolution";
import { clampItemString } from "@squirrelscan/core-contracts/clamp";
import { alignItemSources } from "@squirrelscan/core-contracts/item-sources";
import { ENTITY_MAP_PUBLISH_LIMITS, type EntityMap } from "@squirrelscan/core-contracts/entity-map";
import { projectEntityMap } from "@squirrelscan/core-contracts/entity-map-project";
import {
  PUBLISHED_REPORT_MAX_BYTES,
  PUBLISH_LIMITS,
  REPORT_CAPS,
  REPORT_LIMITS,
  type ReportCapTier,
} from "@squirrelscan/core-contracts/limits";
import {
  clampCheckDetails,
  clampCheckItemIds,
  clampCheckItemsOverflow,
  clampCheckStrings,
  DEFAULT_FOLD_LIMITS,
  foldGroupKey,
  foldOverflowChecks,
  maxChecksTruncated,
  stampChecksTruncated,
  unfoldAggregateCheck,
} from "@squirrelscan/rules/fold";
import { checkAffectedPages } from "@squirrelscan/report/affected-pages";
import {
  buildPublishResolution,
  PAGE_STATUSES_KEY_BYTES,
  RESOLUTION_SIGNAL_KEY_BYTES,
} from "@squirrelscan/rules/resolution";
import { byteLength } from "@squirrelscan/utils/bytes";
import { RULE_ID_ROBOTS_TXT, RULE_ID_SITEMAP_EXISTS } from "@squirrelscan/utils/constants";
import { encodeLinkTargetSet } from "@squirrelscan/utils/link-target-set";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { isReplayedCheck, REMOVED_STATUSES } from "./published-checks";
import { addChecksToTally, emptyTally } from "./scoring";

/** The rule meta fields the capper reads. Either producer's meta satisfies it. */
export type CappableRuleMeta = Pick<
  RuleMetaLite,
  "id" | "name" | "category" | "subcategory" | "scope" | "severity" | "weight"
>;

/**
 * The rule meta a capped report keeps. `description` stays, EMPTY, because the
 * publish schema requires the field; its text and the `solution` are joined
 * from the rule catalog at render time (`withCatalogRuleText` in
 * `@squirrelscan/report`), so no report carries a copy of them. `solution` is
 * never set by the capper; it is on the type for the meta that join produces.
 */
export type CappedRuleMeta = CappableRuleMeta & { description: string; solution?: string };

/** What the capper reads off a report. Both producers' report types satisfy it. */
export interface CappableReport {
  ruleResults: Record<string, { meta: CappableRuleMeta; checks: CheckResult[] }>;
  siteChecks?: CheckResult[] | null;
  pages?: ReadonlyArray<{ url?: unknown; statusCode?: unknown }> | null;
  pageStatuses?: Array<{ url: string; status: number }> | null;
  /** Never published: the capper builds the compact signal from `pages` itself. */
  resolutionSignal?: ResolutionSignal | null;
  /** Never trusted from the input: the capper builds its own from `pages`. */
  resolutionSignalCompact?: unknown;
  entityMap?: EntityMap | null;
  summary?: unknown;
  sitemaps?: unknown;
  robotsTxt?: unknown;
  resourceSizes?: unknown;
  sitemapUrlStatuses?: unknown;
  rulesCache?: unknown;
  checkTallies?: unknown;
  /** Never trusted from the input: the capper counts its own (repo#2935). */
  rulePageCounts?: unknown;
  /** Never trusted from the input: the capper builds its own (repo#2861). */
  linkTargetSets?: unknown;
  detail?: unknown;
}

/** The published shape: the input's other fields, with every list capped. */
export type CappedReport<T extends CappableReport> = Omit<
  T,
  | "pages"
  | "ruleResults"
  | "siteChecks"
  | "entityMap"
  | "rulesCache"
  | "checkTallies"
  | "rulePageCounts"
  | "linkTargetSets"
  | "detail"
  | "resolutionSignal"
  | "resolutionSignalCompact"
  | "pageStatuses"
> & {
  pages: [];
  ruleResults: Record<string, { meta: CappedRuleMeta; checks: CheckResult[] }>;
  siteChecks: CheckResult[];
  entityMap?: EntityMap;
  checkTallies: CheckTallies;
  /** Absent when no rule needs one (see {@link rulePageCount}). */
  rulePageCounts?: Record<string, number>;
  /** Absent when no link rule ran (see {@link buildLinkTargetSets}). */
  linkTargetSets?: Record<string, LinkTargetSets>;
  detail: PublishedReportDetail;
  resolutionSignalCompact?: CompactResolutionSignal;
  pageStatuses?: Array<{ url: string; status: number }>;
};

export interface CapReportOptions {
  /** Where the full per-page detail lives, stamped as `detail.fullDetail`. */
  fullDetail?: PublishedReportDetail["fullDetail"];
  /** Whole-body budget, envelope included. Defaults to PUBLISHED_REPORT_MAX_BYTES. */
  maxBytes?: number;
}

/**
 * A report that does not fit: its skeleton alone (score, rule meta, tallies,
 * enrichment sections) is over the budget after every list has been emptied
 * (`part: "skeleton"`), or the finished body, transport included, is over the
 * ceiling (`part: "body"`, which the fitter should make impossible). Never
 * expected: the worst-case tests assert how far from it real shapes are.
 * Carries the largest sections so the cause is visible without the body.
 *
 * Everything on it is a size, a count or a top-level section name, never a URL
 * or report text, so a producer can send it to its error reporting as is: the
 * cloud container reports it to Sentry (repo#2669).
 */
export class PublishedReportTooLargeError extends Error {
  readonly code = "PUBLISHED_REPORT_TOO_LARGE";
  /** The fitter stage it failed at (`PublishedReportDetail.tier`). */
  readonly tier: number;
  /** Pages the report crawled. */
  readonly pages: number;
  constructor(
    readonly bytes: number,
    readonly budgetBytes: number,
    readonly largestSections: Record<string, number>,
    readonly part: "skeleton" | "body" = "skeleton",
    context: { tier?: number; pages?: number } = {},
  ) {
    super(
      `Published report ${part} is ${bytes} bytes, over its ${budgetBytes}-byte budget ` +
        `(largest: ${Object.entries(largestSections)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")})`,
    );
    this.name = "PublishedReportTooLargeError";
    this.tier = context.tier ?? 0;
    this.pages = context.pages ?? 0;
  }
}

// ── Link target sets ────────────────────────────────────────────

/** A count a rule recorded in a row's `details`, or 0. */
function detailNumber(details: unknown, key: string): number {
  const value = (details as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A row that lists fewer targets than it found, before the capper samples
 * anything: the rule's own sample (`details.listed`, `details.totalBroken` past
 * its items, or a `value` past them: the refused and not-requested external
 * rows count their links in `value`), an input aggregate's `additional`, or the
 * per-check item cap. A row whose `value` is something else only reads as
 * partial, which fails safe: an incomplete set never says a target is absent.
 */
function listsPartially(check: CheckResult): boolean {
  const items = check.items?.length ?? 0;
  return (
    detailNumber(check.details, "listed") > 0 ||
    detailNumber(check.details, "additional") > 0 ||
    detailNumber(check.details, "totalBroken") > items ||
    (typeof check.value === "number" && check.value > items) ||
    items >= REPORT_LIMITS.maxItemsPerCheck
  );
}

/**
 * repo#2861: per link rule in {@link LINK_TARGET_SET_RULES} that ran, the set
 * of every target its failing rows list and every one its unverifiable rows
 * list, hashed (`encodeLinkTargetSet`), from the rows as the producer sent
 * them, before anything is sampled. Kept whole at every tier: a broken link
 * alert compares two audits' sets to tell a link that broke since the previous
 * audit from one that was already broken, which the sampled rows cannot.
 *
 * A rule that did not run this audit (no fresh pass or failing row: skipped, or
 * only rows replayed from an earlier audit) gets none. A replayed row's
 * targets do count when the rule ran: one listed broken last time and not
 * re-checked may still be, and reading it as listed can only hold an alert
 * back.
 */
function buildLinkTargetSets(
  ruleResults: Record<string, { checks: CheckResult[] }>,
): Record<string, LinkTargetSets> {
  const out: Record<string, LinkTargetSets> = {};
  for (const [ruleId, rows] of Object.entries(LINK_TARGET_SET_RULES)) {
    const checks = ruleResults[ruleId]?.checks;
    if (!Array.isArray(checks)) continue;
    const main = checks.filter((c) => c.name === rows.broken);
    const ran = main.some(
      (c) =>
        (c.status === "pass" || c.status === "fail" || c.status === "warn") &&
        c.provenance !== "carried" &&
        c.provenance !== "unrendered",
    );
    if (!ran) continue;
    const broken = main.filter((c) => c.status === "fail" || c.status === "warn");
    const unverified = checks.filter((c) => rows.unverified.includes(c.name));
    const ids = (list: CheckResult[]) => list.flatMap((c) => (c.items ?? []).map((item) => item.id));
    out[ruleId] = {
      broken: encodeLinkTargetSet(ids(broken), { partial: broken.some(listsPartially) }),
      unverified: encodeLinkTargetSet(ids(unverified), {
        partial: unverified.some(listsPartially),
      }),
    };
  }
  return out;
}

// ── Tallies ─────────────────────────────────────────────────────

/**
 * This run's fresh evaluated checks per rule and check name (see
 * {@link CheckTally}). Counted over the UNFOLDED checks with the scorer's own
 * `addChecksToTally`, exactly as the server rescore counts a published report
 * today, so a reader that sums them gets the numbers it would have counted from
 * the rows the capper drops. Page replays are left out as that rescore leaves
 * them out (`isReplayedCheck`, repo#2657); so are checks on a page that
 * returned 404/410, which `capReportForPublish` removes before counting.
 *
 * A (rule, check name) whose checks score nothing (info only) has no entry, so
 * a reader takes a missing rule or check name as 0 scored, never as unknown.
 *
 * If the input was itself already sampled (an aggregate whose `pages` is shorter
 * than its `pagesTruncated`), the counts are a floor, same as a rescore of it.
 */
export function buildCheckTallies(
  ruleResults: Record<string, { meta: { severity: string }; checks: CheckResult[] }>,
): CheckTallies {
  const out: CheckTallies = {};
  for (const ruleId of Object.keys(ruleResults).sort()) {
    const rule = ruleResults[ruleId];
    if (!rule || !Array.isArray(rule.checks)) continue;
    const byName = new Map<string, CheckResult[]>();
    for (const original of rule.checks) {
      for (const check of unfoldAggregateCheck(original)) {
        if (isReplayedCheck(check)) continue;
        const list = byName.get(check.name);
        if (list) list.push(check);
        else byName.set(check.name, [check]);
      }
    }
    const advisory = rule.meta.severity === "info";
    let perName: Record<string, CheckTally> | undefined;
    for (const name of [...byName.keys()].sort()) {
      const checks = byName.get(name)!;
      const tally = emptyTally();
      addChecksToTally(tally, checks, advisory);
      let skipped = 0;
      for (const check of checks) if (check.status === "skipped") skipped++;
      const entry: CheckTally = {};
      if (tally.passed > 0) entry.passed = tally.passed;
      if (tally.warnings > 0) entry.warnings = tally.warnings;
      if (tally.failed > 0) entry.failed = tally.failed;
      if (tally.warnUnits > 0) entry.warnUnits = tally.warnUnits;
      if (tally.failUnits > 0) entry.failUnits = tally.failUnits;
      if (skipped > 0) entry.skipped = skipped;
      // A class of info checks only scores nothing and says nothing a reader
      // needs; leaving it out keeps the tallies to the classes that count.
      if (Object.keys(entry).length === 0) continue;
      (perName ??= {})[name] = entry;
    }
    if (perName) out[ruleId] = perName;
  }
  return out;
}

// ── Rule page counts ────────────────────────────────────────────

/**
 * The distinct pages a rule fails or warns on this run (squirrelscan/repo#2935),
 * when its issue classes reach pages its largest class does not; undefined
 * when the largest class holds every page.
 *
 * The published rows sample every class with its true count, but the pages a
 * sample leaves out cannot be told apart across classes, so a reader can only
 * take the largest class as a floor: two disjoint classes of 46 and 4 pages
 * read 46. This is the union, from the full report before sampling: the pages
 * of this run's page-attributed fail and warn checks (a per-page check's
 * `pageUrl`, a folded aggregate's `pages`). Replays are left out, as the
 * tallies leave them out (the server's merge replaces them from its own
 * store), so a reader that adds replayed pages back knows the count is then a
 * floor. `classes` are the originals of each class as foldRule keys them. A
 * rule with an input aggregate that was itself already sampled gets no count:
 * its union would be a floor too, and a published count is exact.
 */
function rulePageCount(classes: Iterable<CheckResult[]>): number | undefined {
  const union = new Set<string>();
  let largest = 0;
  for (const originals of classes) {
    const pages = new Set<string>();
    for (const check of originals) {
      // An input aggregate that was itself already sampled hides pages this
      // union cannot see: no exact count, so none is published.
      const truncated = check.details?.pagesTruncated;
      if (typeof truncated === "number" && truncated > (check.pages?.length ?? 0)) return undefined;
      if (check.pageUrl) pages.add(check.pageUrl);
      for (const page of check.pages ?? []) pages.add(page);
    }
    for (const page of pages) union.add(page);
    largest = Math.max(largest, pages.size);
  }
  return union.size > largest ? union.size : undefined;
}

// ── Issue classes ───────────────────────────────────────────────

/** What `foldGroup` appends to an aggregate's message. */
const FOLD_SUFFIX = / \(\+\d+ more pages\)$/;

/** Lower sorts first: what a reader most needs to see survives a cut. */
const STATUS_RANK: Record<string, number> = { fail: 0, warn: 1, info: 2, skipped: 3, pass: 4 };

/** Rules whose site checks the critical-penalty scorer reads by name. */
const PINNED_RULES = new Set<string>([RULE_ID_ROBOTS_TXT, RULE_ID_SITEMAP_EXISTS]);

/** One entry of a rule's published checks, folded once, sampled per level. */
interface ClassUnit {
  ruleId: string;
  check: CheckResult;
  /** Position in the rule's output, which no cut reorders. */
  order: number;
  /** Findings the class stands for, the size a cut ranks it by. */
  size: number;
  /** Pages the check names before sampling (see sampleCheck). */
  affected: number;
  /** A site check's identity for the top-level `siteChecks` dedupe (see siteCheckKey). */
  key?: string;
}

function unitOf(
  ruleId: string,
  check: CheckResult,
  order: number,
  affected: number = affectedPageCount(check),
  key?: string,
): ClassUnit {
  return { ruleId, check, order, size: occurrencesOf(check), affected, ...(key !== undefined ? { key } : {}) };
}

interface FoldedRule {
  id: string;
  meta: CappedRuleMeta;
  /** The classes kept, in output order (at most REPORT_CAPS.classesPerRule). */
  kept: ClassUnit[];
  /** True class total, reconciled with any total an earlier cap recorded. */
  total: number;
  /** The rule's distinct failing pages, when its classes cannot add up to it ({@link rulePageCount}). */
  pageCount?: number;
}

function occurrencesOf(check: CheckResult): number {
  const occurrences = check.details?.occurrences;
  const pages = check.details?.pagesTruncated;
  const n = Math.max(
    typeof occurrences === "number" && Number.isFinite(occurrences) ? occurrences : 1,
    typeof pages === "number" && Number.isFinite(pages) ? pages : 1,
    check.pages?.length ?? 1,
  );
  return Math.max(1, Math.floor(n));
}

/**
 * A "not checked" skip (repo#2729) is what stops the report and the server's
 * issue sync reading the rule as clean, and it is one small row, so no cut may
 * drop it ahead of anything else.
 */
function isNotCheckedUnit(unit: ClassUnit): boolean {
  const { status, skipReason } = unit.check;
  return status === "skipped" && skipReason !== undefined && NOT_CHECKED_SKIP_REASONS.has(skipReason);
}

/** Priority order for any cut: status, then size, then a stable identity. */
function compareUnits(a: ClassUnit, b: ClassUnit): number {
  const pinned = Number(PINNED_RULES.has(b.ruleId)) - Number(PINNED_RULES.has(a.ruleId));
  if (pinned !== 0) return pinned;
  const notChecked = Number(isNotCheckedUnit(b)) - Number(isNotCheckedUnit(a));
  if (notChecked !== 0) return notChecked;
  const rank = (STATUS_RANK[a.check.status] ?? 5) - (STATUS_RANK[b.check.status] ?? 5);
  if (rank !== 0) return rank;
  if (a.size !== b.size) return b.size - a.size;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return a.order - b.order;
}

/** Where a class member sits, for an order that does not depend on crawl order. */
function memberPage(check: CheckResult): string {
  return check.pageUrl ?? check.pages?.[0] ?? "";
}

function compareMembers(a: CheckResult, b: CheckResult): number {
  const pa = memberPage(a);
  const pb = memberPage(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/**
 * The fold keeps every page, item and source page: the sample clips them, and
 * it has to see them all to rank items and pin the worst page. Bounded by the
 * input, which already holds every one of them. Measured on a synthetic 10,000
 * pages x 24 checks (240k checks, up to 11 items on each warn or fail): 0.8 s,
 * heap +141 MB right after the call, against +94 MB with the fold's default
 * limits (1,000 items, 100 source pages). The producers run it on a report
 * already in memory; if the API runs it, the input is a publish body, bounded
 * by the route's body limit.
 */
const CLASS_FOLD_LIMITS = {
  ...DEFAULT_FOLD_LIMITS,
  maxChecks: 1,
  maxItemsPerCheck: Number.MAX_SAFE_INTEGER,
  maxPagesPerCheck: Number.MAX_SAFE_INTEGER,
  maxSourcePagesPerItem: Number.MAX_SAFE_INTEGER,
};

/**
 * The page a class hits hardest: the most items on one page (a check without
 * items counts once), from each per-page member and from the source pages of
 * an aggregate's items. Ties go to URL order. Undefined when no page of `pages`
 * outweighs another, so a class with one finding per page keeps its sorted
 * sample.
 */
function worstPage(members: CheckResult[], pages: string[]): string | undefined {
  const weight = new Map<string, number>();
  const add = (page: string, n: number): void => {
    weight.set(page, (weight.get(page) ?? 0) + n);
  };
  for (const check of members) {
    if (check.pageUrl) {
      add(check.pageUrl, Math.max(1, (check.items?.length ?? 0) + additionalOf(check)));
      continue;
    }
    for (const item of check.items ?? []) {
      for (const page of new Set(item.sourcePages ?? [])) add(page, 1);
    }
  }
  let best: string | undefined;
  let bestWeight = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    const w = weight.get(page) ?? 0;
    lowest = Math.min(lowest, w);
    if (w > bestWeight || (w === bestWeight && best !== undefined && page < best)) {
      best = page;
      bestWeight = w;
    }
  }
  return bestWeight > lowest ? best : undefined;
}

/** `check` with its worst page first and the rest in URL order. */
function pinWorstPage(check: CheckResult, members: CheckResult[]): CheckResult {
  if (!check.pages || check.pages.length < 2) return check;
  const worst = worstPage(members, check.pages);
  if (worst === undefined || worst === check.pages[0]) return check;
  return { ...check, pages: [worst, ...check.pages.filter((page) => page !== worst)] };
}

/**
 * An item's page count as the largest any member recorded: the fold keeps the
 * first member's copy of a repeated item, so a larger `pageCount` on a later
 * copy (an input that was itself capped) would otherwise be lost.
 */
function keepPriorPageCounts(check: CheckResult, members: CheckResult[]): CheckResult {
  if (!check.items) return check;
  let prior: Map<string, number> | undefined;
  for (const member of members) {
    for (const item of member.items ?? []) {
      const n = item.pageCount;
      if (typeof n !== "number" || !Number.isFinite(n)) continue;
      prior ??= new Map();
      if (n > (prior.get(item.id) ?? 0)) prior.set(item.id, Math.floor(n));
    }
  }
  if (!prior) return check;
  return {
    ...check,
    items: check.items.map((item) => {
      const n = prior.get(item.id);
      return n !== undefined && n > itemPageCount(item) ? { ...item, pageCount: n } : item;
    }),
  };
}

/**
 * One aggregate for a whole issue class. A class of one keeps its check as is:
 * a single per-page check is the truth about one page, and an existing
 * aggregate is already the fold of its class. A class of several is folded
 * from scratch: members in page order, so the aggregate's message and item
 * details come from the same page however the crawl ordered them, and any
 * earlier fold's message suffix stripped first so it cannot stack. Either way
 * an aggregate's pages lead with its worst page (see {@link worstPage}).
 */
function foldClass(members: CheckResult[]): CheckResult {
  if (members.length === 1) {
    const only = members[0]!;
    if (only.details?.aggregated !== true) return only;
    // An aggregate built elsewhere may list its pages in any order; the sample
    // is its first pages, so put them in the order a fold here would.
    const sorted: CheckResult = {
      ...only,
      ...(only.pages ? { pages: [...only.pages].sort() } : {}),
      ...(only.items ? { items: [...only.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) } : {}),
    };
    return pinWorstPage(sorted, [sorted]);
  }
  const clean = [...members].sort(compareMembers).map((check) =>
    check.details?.aggregated === true && FOLD_SUFFIX.test(check.message)
      ? { ...check, message: check.message.replace(FOLD_SUFFIX, "") }
      : check,
  );
  const folded = foldOverflowChecks(clean, CLASS_FOLD_LIMITS)[0]!;
  return pinWorstPage(keepPriorPageCounts(folded, clean), clean);
}

function compareNames(a: CheckResult, b: CheckResult): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function compareClassOrder(a: CheckResult, b: CheckResult): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.status !== b.status) return a.status < b.status ? -1 : 1;
  const ka = foldGroupKey(a);
  const kb = foldGroupKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function capMeta(meta: CappableRuleMeta): CappedRuleMeta {
  return {
    id: meta.id,
    name: meta.name,
    description: "",
    category: meta.category,
    ...(meta.subcategory !== undefined ? { subcategory: meta.subcategory } : {}),
    scope: meta.scope,
    severity: meta.severity,
    weight: meta.weight,
  };
}

/** The publish clamps every producer applies to a check list (`capMixedRuleChecksForPublish`'s). */
function clampChecks(checks: CheckResult[]): CheckResult[] {
  return clampCheckItemsOverflow(
    clampCheckItemIds(clampCheckDetails(clampCheckStrings(checks))),
  );
}

/**
 * The clamps, with an oversized items array ranked first so the items cap keeps
 * the most widespread ones rather than the first seen.
 */
function boundChecks(checks: CheckResult[]): CheckResult[] {
  return clampChecks(
    checks.map((check) =>
      check.items && check.items.length > REPORT_LIMITS.maxItemsPerCheck
        ? { ...check, items: rankItems(check.items) }
        : check,
    ),
  );
}

/**
 * A site check's identity, compared as the plain clamps leave it: the top-level
 * `siteChecks` copy was clamped that way by the producer, unranked, so the
 * rule's own copy has to be too for the two to match.
 */
function siteCheckKey(original: CheckResult, bounded: CheckResult): string {
  const ranked = (original.items?.length ?? 0) > REPORT_LIMITS.maxItemsPerCheck;
  return stableKey(ranked ? clampChecks([original])[0]! : bounded);
}

/**
 * Pages a class names, counted on its checks as the rule emitted them:
 * `boundChecks` clamps an oversized items array, and with it the pages its
 * items named, so a count taken after it would understate the total. The union
 * over every member, so two members naming different pages both count.
 */
function affectedBeforeBounds(originals: CheckResult[], bounded: CheckResult): number {
  if (bounded.pageUrl) return 0;
  const pages = checkAffectedPages(bounded);
  for (const original of originals) {
    if (original.pageUrl) continue;
    for (const page of checkAffectedPages(original)) pages.add(page);
  }
  return pages.size;
}

function foldRule(ruleId: string, rule: { meta: CappableRuleMeta; checks: CheckResult[] }): FoldedRule {
  const originals = Array.isArray(rule.checks) ? rule.checks : [];
  // Every clamp maps one check to one check, so index i is the same check in both.
  const checks = boundChecks(originals);
  const site: Array<{ check: CheckResult; original: CheckResult }> = [];
  const classes = new Map<string, { members: CheckResult[]; originals: CheckResult[] }>();
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    const original = originals[i]!;
    const pageAttributed = !!check.pageUrl || check.details?.aggregated === true;
    if (!pageAttributed) {
      site.push({ check, original });
      continue;
    }
    // A page passing renders nothing; its count is in the tallies.
    if (check.status === "pass") continue;
    const key = foldGroupKey(check);
    const entry = classes.get(key);
    if (entry) {
      entry.members.push(check);
      entry.originals.push(original);
    } else {
      classes.set(key, { members: [check], originals: [original] });
    }
  }
  const folded = [...classes.values()]
    .map((entry) => {
      const check = foldClass(entry.members);
      return { check, affected: affectedBeforeBounds(entry.originals, check) };
    })
    .sort((a, b) => compareClassOrder(a.check, b.check));
  const entries: Array<{ check: CheckResult; affected: number; key?: string }> = [
    ...site.map(({ check, original }) => ({
      check,
      affected: affectedBeforeBounds([original], check),
      key: siteCheckKey(original, check),
    })),
    ...folded,
  ];
  const units = entries.map((entry, order) =>
    unitOf(ruleId, entry.check, order, entry.affected, entry.key),
  );
  const total = Math.max(units.length, maxChecksTruncated(checks));
  let kept = units;
  if (units.length > REPORT_CAPS.classesPerRule) {
    kept = [...units]
      .sort(compareUnits)
      .slice(0, REPORT_CAPS.classesPerRule)
      .sort((a, b) => a.order - b.order);
  }
  // A class is one status and one provenance (foldGroupKey): its first member
  // says which. Replays are left out, as the tallies leave them out: the
  // server's merge replaces them from its own store.
  const pageCount = rulePageCount(
    [...classes.values()]
      .filter((entry) => {
        const first = entry.members[0]!;
        return (first.status === "fail" || first.status === "warn") && !isReplayedCheck(first);
      })
      .map((entry) => entry.originals),
  );
  return {
    id: ruleId,
    meta: capMeta(rule.meta),
    kept,
    total,
    ...(pageCount !== undefined ? { pageCount } : {}),
  };
}

// ── Sampling ────────────────────────────────────────────────────

interface SampleCaps {
  pages: number;
  items: number;
  sourcePages: number;
  messageChars: number;
  /** Counts only: no samples, and `details` reduced to the count fields. */
  countsOnly: boolean;
}

/**
 * The `details` keys that carry a class's true totals and identity, and what
 * links/broken-links covered (pub#794): a reader comparing two audits' broken
 * links needs those counts most on the large reports a counts row comes from.
 */
const COUNT_KEYS = [
  "aggregated",
  "occurrences",
  "pagesTruncated",
  "additional",
  "checksTruncated",
  "foldKey",
  ...LINK_COVERAGE_DETAIL_KEYS,
] as const;

function additionalOf(check: CheckResult): number {
  const extra = check.details?.additional;
  return typeof extra === "number" && Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : 0;
}

function clampMessage(message: string, aggregated: boolean, max: number): string {
  if (message.length <= max) return message;
  const suffix = aggregated ? (FOLD_SUFFIX.exec(message)?.[0] ?? "") : "";
  const base = suffix ? message.slice(0, message.length - suffix.length) : message;
  return clampItemString(base, max) + suffix;
}

/** Distinct pages an item names, or what an earlier cap recorded if more. */
function itemPageCount(item: CheckItem): number {
  const listed = item.sourcePages ? new Set(item.sourcePages).size : 0;
  const prior = item.pageCount;
  return typeof prior === "number" && Number.isFinite(prior) && prior > listed ? Math.floor(prior) : listed;
}

/**
 * Items on the most pages first: one item on half a class's pages is a
 * template-level fix, and a first-seen sample misses it (repo#2656: it held the
 * most widespread item 60% of the time on cloud reports). Stable, so items on
 * as many pages keep the order they came in.
 *
 * Exact over the checks this function is given. A rule the producer already
 * folded (past REPORT_LIMITS.maxChecksPerRule checks) arrives with its first
 * 1,000 items and at most 100 source pages each, so for it the ranking and
 * `pageCount` are over what that fold kept.
 */
function rankItems(items: CheckItem[]): CheckItem[] {
  return items
    .map((item, index) => ({ item, index, pages: itemPageCount(item) }))
    .sort((a, b) => b.pages - a.pages || a.index - b.index)
    .map(({ item }) => item);
}

function sampleItem(item: CheckItem, caps: SampleCaps): CheckItem {
  const next: CheckItem = { ...item };
  // A label equal to the id says nothing the id does not (134KB on one real report).
  if (next.label !== undefined && next.label === next.id) delete next.label;
  if (next.snippet !== undefined) next.snippet = clampItemString(next.snippet, caps.messageChars);
  if (next.sourcePages) {
    const pages = itemPageCount(item);
    // URL order, so the page kept does not depend on the order the crawl met them.
    const unique = [...new Set(next.sourcePages)].sort();
    if (caps.sourcePages <= 0) delete next.sourcePages;
    else next.sourcePages = unique.slice(0, caps.sourcePages);
    // The true spread, when the sample no longer lists every page.
    if (pages > (next.sourcePages?.length ?? 0)) next.pageCount = pages;
    else delete next.pageCount;
  }
  // pub#837: per-source detail goes with the pages the sample kept.
  return alignItemSources(next);
}

/**
 * One check at one sample level: page and item samples (items on the most
 * pages first, see {@link rankItems}), with the true totals kept in
 * `details.pagesTruncated` (preserved if an earlier sample recorded more) and
 * `details.additional` (added to the rule's own remainder).
 *
 * A check without a `pageUrl` can name its affected pages through its items as
 * well as `pages` (`checkAffectedPages`: an item's `sourcePages`, or an item
 * whose id is itself a page). Sampling items shrinks that set too, so its
 * pre-sample size is what `pagesTruncated` records. A per-page check's items
 * are things on that one page, never other pages, so it gets no page total.
 */
function sampleCheck(
  check: CheckResult,
  caps: SampleCaps,
  affectedBefore: number = affectedPageCount(check),
): CheckResult {
  const out: CheckResult = { ...check };
  const aggregated = check.details?.aggregated === true;
  let details: Record<string, unknown> | undefined = check.details;

  out.message = clampMessage(check.message, aggregated, caps.messageChars);
  if (typeof check.value === "string") out.value = clampItemString(check.value, caps.messageChars);
  if (typeof check.expected === "string") {
    out.expected = clampItemString(check.expected, caps.messageChars);
  }
  if (check.skipReason !== undefined) {
    out.skipReason = clampItemString(check.skipReason, caps.messageChars);
  }

  if (check.pages && check.pages.length > caps.pages) {
    if (caps.pages > 0) out.pages = check.pages.slice(0, caps.pages);
    else delete out.pages;
  }

  if (check.items && check.items.length > 0) {
    // Ranked at most twice per class: renders are memoized per sample level,
    // and a counts row keeps no items to rank.
    const kept = caps.items > 0 ? rankItems(check.items).slice(0, caps.items) : [];
    const dropped = check.items.length - kept.length;
    if (dropped > 0) details = { ...details, additional: additionalOf(check) + dropped };
    if (kept.length > 0) out.items = kept.map((item) => sampleItem(item, caps));
    else delete out.items;
  }

  if (!check.pageUrl) {
    const affectedAfter = checkAffectedPages(out).size;
    if (affectedAfter < affectedBefore) {
      const prior = details?.pagesTruncated;
      const known = typeof prior === "number" && Number.isFinite(prior) ? Math.floor(prior) : 0;
      details = { ...details, pagesTruncated: Math.max(known, affectedBefore) };
    }
  }

  if (caps.countsOnly && details) {
    const counts: Record<string, unknown> = {};
    for (const key of COUNT_KEYS) if (details[key] !== undefined) counts[key] = details[key];
    details = Object.keys(counts).length > 0 ? counts : undefined;
  }
  if (details) out.details = details;
  else delete out.details;
  return out;
}

/** Pages a check names, before sampling; 0 for a per-page check (see sampleCheck). */
function affectedPageCount(check: CheckResult): number {
  return check.pageUrl ? 0 : checkAffectedPages(check).size;
}

function classCaps(tier: ReportCapTier, countsOnly: boolean): SampleCaps {
  return {
    pages: tier.pagesPerClass,
    items: tier.itemsPerClass,
    sourcePages: tier.sourcePagesPerItem,
    messageChars: tier.messageChars,
    countsOnly,
  };
}

/** Top-level `siteChecks` keep the site caps, never more than the level's own. */
function siteCaps(level: number, tier: ReportCapTier, countsOnly: boolean): SampleCaps {
  const first = level === 0;
  return {
    pages: first ? REPORT_CAPS.siteCheckPages : Math.min(REPORT_CAPS.siteCheckPages, tier.pagesPerClass),
    items: first ? REPORT_CAPS.siteCheckItems : Math.min(REPORT_CAPS.siteCheckItems, tier.itemsPerClass),
    sourcePages: tier.sourcePagesPerItem,
    messageChars: tier.messageChars,
    countsOnly,
  };
}

// ── Fixed sections ──────────────────────────────────────────────

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sliceList(value: unknown, max: number): unknown {
  return Array.isArray(value) && value.length > max ? value.slice(0, max) : value;
}

/**
 * Every summary list to the publish sample, and any list inside an entry too.
 * Two levels is the whole depth of the summary: lists of URLs, or of entries
 * holding one list (`urlIssues[].issues`, `redirectChains[].hops`, ...).
 */
function capSummary(summary: unknown, max: number): unknown {
  if (!isRecord(summary)) return summary;
  const out: Loose = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.slice(0, max).map((entry) => {
      if (!isRecord(entry)) return entry;
      const next: Loose = { ...entry };
      for (const [k, v] of Object.entries(entry)) if (Array.isArray(v)) next[k] = v.slice(0, max);
      return next;
    });
  }
  return out;
}

/**
 * How much of the display-only sections a body keeps: `normal`, the `minimal`
 * the fitter falls back to when the counts rows alone do not fit, and `empty`
 * for a last-resort admission whose skeleton does not fit even then.
 */
type SectionMode = "normal" | "minimal" | "empty";

function capSitemaps(sitemaps: unknown, mode: SectionMode): unknown {
  if (!isRecord(sitemaps)) return sitemaps;
  const discovered = Array.isArray(sitemaps.discovered) ? sitemaps.discovered : undefined;
  const normal = mode === "normal";
  const entries =
    mode === "normal"
      ? REPORT_CAPS.sitemapEntries
      : mode === "minimal"
        ? REPORT_CAPS.minimalSitemapEntries
        : 0;
  const out: Loose = {
    ...sitemaps,
    ...(discovered
      ? {
          discovered: discovered.slice(0, entries).map((s: unknown) =>
            isRecord(s)
              ? {
                  ...s,
                  urls: sliceList(s.urls, normal ? REPORT_CAPS.sitemapUrls : 0),
                  childSitemaps: sliceList(s.childSitemaps, normal ? REPORT_CAPS.sitemapChildren : 0),
                  errors: sliceList(s.errors, normal ? PUBLISH_LIMITS.maxSummary : 0),
                }
              : s,
          ),
        }
      : {}),
  };
  const listMax = normal ? PUBLISH_LIMITS.maxSummary : 0;
  for (const key of ["orphanPages", "missingPages", "failed"]) {
    if (Array.isArray(sitemaps[key])) out[key] = (sitemaps[key] as unknown[]).slice(0, listMax);
  }
  if (isRecord(sitemaps.sources)) {
    const sources: Loose = {};
    for (const [k, v] of Object.entries(sitemaps.sources)) sources[k] = sliceList(v, listMax);
    out.sources = sources;
  }
  return out;
}

function capRobotsTxt(robots: unknown, mode: SectionMode): unknown {
  if (!isRecord(robots)) return robots;
  // Display only: the critical-penalty scorer reads the robots-txt rule's checks.
  const empty = mode !== "normal";
  const out: Loose = { ...robots };
  if (typeof robots.content === "string") {
    out.content = empty ? null : clampItemString(robots.content, REPORT_LIMITS.maxLongString);
  }
  const listMax = empty ? 0 : PUBLISH_LIMITS.maxSummary;
  if (Array.isArray(robots.sitemaps)) out.sitemaps = robots.sitemaps.slice(0, listMax);
  if (Array.isArray(robots.errors)) out.errors = robots.errors.slice(0, listMax);
  if (Array.isArray(robots.rules)) {
    // A directive budget across every user-agent group, in file order.
    let budget = empty ? 0 : REPORT_CAPS.robotsDirectives;
    const groups: unknown[] = [];
    for (const group of robots.rules) {
      if (budget <= 0) break;
      if (!isRecord(group) || !Array.isArray(group.rules)) {
        groups.push(group);
        continue;
      }
      const rules = group.rules.slice(0, budget);
      budget -= rules.length;
      groups.push({ ...group, rules });
    }
    out.rules = groups;
  }
  return out;
}

function capResourceSizes(resources: unknown, mode: SectionMode): unknown {
  if (!isRecord(resources)) return resources;
  const rowsMax =
    mode === "normal"
      ? REPORT_CAPS.resourceRowsPerCategory
      : mode === "minimal"
        ? REPORT_CAPS.minimalResourceRows
        : 0;
  const sourcesMax = mode === "normal" ? REPORT_CAPS.resourceSourcePages : 0;
  const out: Loose = {};
  for (const [category, rows] of Object.entries(resources)) {
    out[category] = Array.isArray(rows)
      ? rows.slice(0, rowsMax).map((row: unknown) =>
          isRecord(row) && Array.isArray(row.sourcePages)
            ? { ...row, sourcePages: row.sourcePages.slice(0, sourcesMax) }
            : row,
        )
      : rows;
  }
  return out;
}

/**
 * The entity map at its publish bound. `failed` when the report had one that
 * could not be projected: derived, report-only data is left out rather than
 * failing a finished audit's publish, and the stamp says so
 * (`detail.entityMapFailed`), apart from a budget drop (`entityMapDropped`).
 */
function slimEntityMap(map: EntityMap | null | undefined): { map?: EntityMap; failed: boolean } {
  if (!map) return { failed: false };
  try {
    return {
      map: projectEntityMap(
        map,
        { ...ENTITY_MAP_PUBLISH_LIMITS, maxBytes: REPORT_CAPS.entityMapMaxBytes },
        "publish",
      ),
      failed: false,
    };
  } catch {
    return { failed: true };
  }
}

/**
 * Pages that returned 404/410 this run, normalized. Read from the full report,
 * before `pageStatuses` is clipped, and from the same source the published
 * statuses are built from: the producer's `pageStatuses` when it sent them, else
 * its `pages`. The server's removed set is read off those, so the two cannot
 * disagree on a page. See {@link withoutRemovedPages}.
 */
function removedPageUrls(report: CappableReport): Set<string> {
  const out = new Set<string>();
  const add = (url: unknown, status: unknown): void => {
    if (typeof url === "string" && typeof status === "number" && REMOVED_STATUSES.has(status)) {
      out.add(normalizePageUrl(url));
    }
  };
  if (Array.isArray(report.pageStatuses)) {
    for (const row of report.pageStatuses) add(row?.url, row?.status);
  } else if (Array.isArray(report.pages)) {
    for (const page of report.pages) add(page?.url, page?.statusCode);
  }
  return out;
}

/**
 * The rules without their checks on a page that returned 404/410 this run
 * (repo#2657). The page is gone: the server stales its findings and never scores
 * or shows its checks, so the capper drops them before it counts the tallies and
 * folds the classes, and the two agree. A class whose every page is gone leaves
 * the report.
 *
 * An aggregate from an earlier fold is reopened only when its `pages` name a
 * removed page, so every other class keeps the totals it arrived with. Its true
 * page count drops by the removed pages its sample named; a removed page it had
 * already clipped cannot be seen, so that count stays a floor.
 */
function withoutRemovedPages<R extends { checks: CheckResult[] }>(
  ruleResults: Record<string, R>,
  removedUrls: ReadonlySet<string>,
): Record<string, R> {
  if (removedUrls.size === 0) return ruleResults;
  const removed = (url: string): boolean => removedUrls.has(normalizePageUrl(url));
  const out: Record<string, R> = {};
  for (const [ruleId, rule] of Object.entries(ruleResults)) {
    if (!Array.isArray(rule.checks)) {
      out[ruleId] = rule;
      continue;
    }
    let changed = false;
    const checks: CheckResult[] = [];
    for (const check of rule.checks) {
      if (check.pageUrl) {
        if (removed(check.pageUrl)) changed = true;
        else checks.push(check);
        continue;
      }
      if (check.details?.aggregated !== true || !check.pages?.some(removed)) {
        checks.push(check);
        continue;
      }
      changed = true;
      const members = unfoldAggregateCheck(check);
      // Every member of an unfolded aggregate carries the `pageUrl` it unfolded to.
      const kept = members.filter((member) => !removed(member.pageUrl!));
      const gone = members.length - kept.length;
      for (const member of kept) {
        const total = member.details?.pagesTruncated;
        checks.push({
          ...member,
          // An item's other pages ride along in its `sourcePages`.
          ...(member.items
            ? {
                items: member.items.map((item) =>
                  item.sourcePages?.some(removed)
                    ? alignItemSources({
                        ...item,
                        sourcePages: item.sourcePages.filter((page) => !removed(page)),
                      })
                    : item,
                ),
              }
            : {}),
          ...(typeof total === "number" && Number.isFinite(total)
            ? { details: { ...member.details, pagesTruncated: Math.max(total - gone, kept.length) } }
            : {}),
        });
      }
    }
    out[ruleId] = changed ? { ...rule, checks } : rule;
  }
  return out;
}

/**
 * The pages the scoring transport is built over, in URL order so what its byte
 * budget keeps does not depend on the order pages were crawled in. Statuses come
 * from one source, as {@link removedPageUrls} and the server read them: the
 * producer's `pageStatuses` when it sent them, else each page's own. A URL listed
 * twice keeps a 404/410 over any other status (a removal is what both readers
 * act on), else the higher status, so the order of the rows does not matter. A
 * status row for a page `pages` does not list is a page too, as the server merge
 * counts it.
 */
function transportPages(report: CappableReport): Array<{ url: string; statusCode?: number }> {
  const sent = Array.isArray(report.pageStatuses);
  const rank = (status: number): number => (REMOVED_STATUSES.has(status) ? 1_000 : 0) + status;
  const statusOf = new Map<string, number>();
  const note = (url: unknown, status: unknown): void => {
    if (typeof url !== "string" || typeof status !== "number") return;
    const held = statusOf.get(url);
    if (held === undefined || rank(status) > rank(held)) statusOf.set(url, status);
  };
  const listed = new Set<string>();
  for (const page of Array.isArray(report.pages) ? report.pages : []) {
    if (typeof page?.url !== "string") continue;
    listed.add(page.url);
    if (!sent) note(page.url, page.statusCode);
  }
  if (sent) for (const row of report.pageStatuses!) note(row?.url, row?.status);
  for (const url of statusOf.keys()) listed.add(url);
  return [...listed].sort().map((url) => {
    const statusCode = statusOf.get(url);
    return statusCode === undefined ? { url } : { url, statusCode };
  });
}

// ── Assembly ────────────────────────────────────────────────────

function bytesOf(value: unknown): number {
  return value === undefined ? 0 : byteLength(JSON.stringify(value));
}

/** Top-level keys in one order whatever the producer built, for byte-identical bodies. */
function canonical(body: Loose): Loose {
  const out: Loose = {};
  for (const key of Object.keys(body).sort()) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

function largestSections(body: Loose): Record<string, number> {
  return Object.fromEntries(
    Object.entries(body)
      .map(([key, value]) => [key, bytesOf(value)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  );
}

/** JSON with every object's keys sorted, so two copies of one check match however they were built. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/**
 * Cap a finished report for publish (squirrelscan/repo#2656). See the module
 * note for the ladder. `options.fullDetail` says where the uncapped detail
 * lives (`local` for a CLI audit, `findings` for a cloud run that streams it).
 *
 * The byte budget covers the whole body minus REPORT_CAPS.envelopeBytes. The
 * scoring transport (the compact resolution signal and `pageStatuses`) is sized
 * by pages crawled and cannot be sampled, so it is built first, to its own share
 * (REPORT_CAPS.signalMaxBytes), and the rest of the report gets what it leaves.
 * Build it from the FULL report: the signal is read off `pages` and the
 * pre-sample checks, and any signal already on the input is dropped (the API
 * reads a client's signal off the request it parsed, never off a recapped
 * body). A report without `pages` publishes no signal.
 *
 * Throws {@link PublishedReportTooLargeError} when the skeleton alone does not
 * fit, or (never expected) when the finished body is over the ceiling.
 */
export function capReportForPublish<T extends CappableReport>(
  report: T,
  options: CapReportOptions = {},
): CappedReport<T> {
  const maxBytes = options.maxBytes ?? PUBLISHED_REPORT_MAX_BYTES;

  // 1. Counted from the full report, before anything is sampled.
  const ruleIds = Object.keys(report.ruleResults).sort();
  // Built over rules, check names and pages in a fixed order, so what its byte
  // budget keeps does not depend on the order rules ran or pages were crawled in.
  // Its share scales with the ceiling, so a smaller `maxBytes` shrinks it too.
  // A report with no `pages` (one already slimmed for publish) has lost its
  // crawl list, so it publishes no signal rather than one claiming a crawl of
  // just its status rows. Without a signal the server does not read the
  // tallies either, so pass the capper the full report.
  const share = Math.min(1, maxBytes / PUBLISHED_REPORT_MAX_BYTES);
  const built = buildPublishResolution(
    Object.fromEntries(
      ruleIds.map((id) => {
        const rule = report.ruleResults[id]!;
        const checks = Array.isArray(rule.checks) ? rule.checks : [];
        return [id, { checks: [...checks].sort(compareNames) }];
      }),
    ),
    transportPages(report),
    {
      maxBytes: Math.floor(REPORT_CAPS.signalMaxBytes * share),
      maxPageStatusBytes: Math.floor(REPORT_CAPS.pageStatusesMaxBytes * share),
    },
    // The capped report carries `checkTallies`, the one reader of the page
    // hashes a clipped list ships (#2673).
    { pageHashes: true },
  );
  const pageStatuses = built.pageStatuses;
  const crawled = Array.isArray(report.pages) && report.pages.length > 0;
  const resolutionSignalCompact = crawled ? built.resolutionSignalCompact : undefined;
  // The rows the server scores and shows: none on a page that 404'd or 410'd.
  const live = withoutRemovedPages(report.ruleResults, removedPageUrls(report));
  const checkTallies = buildCheckTallies(live);
  // From the rows as they came, not `live`: unfolding an input aggregate moves
  // its `additional` marker onto one page, and dropping that page would lose it.
  const linkTargetSets = buildLinkTargetSets(report.ruleResults);
  // Exactly what the two fields add to the body. Their builder holds them to
  // REPORT_CAPS.signalMaxBytes together, keys included.
  const transportBytes =
    (resolutionSignalCompact
      ? bytesOf(resolutionSignalCompact) + RESOLUTION_SIGNAL_KEY_BYTES
      : 0) + (pageStatuses ? bytesOf(pageStatuses) + PAGE_STATUSES_KEY_BYTES : 0);
  const ceiling = maxBytes - REPORT_CAPS.envelopeBytes;
  const budget = ceiling - transportBytes;

  // 2. Every rule's classes folded once, in rule-id order.
  const rules = ruleIds.map((id) => foldRule(id, live[id]!));
  const rulePageCounts: Record<string, number> = {};
  for (const rule of rules) if (rule.pageCount !== undefined) rulePageCounts[rule.id] = rule.pageCount;
  // Top-level `siteChecks` repeats the site checks of `ruleResults` (9,137 of
  // 9,138 entries over 187 real reports), and nothing reads it but the schema
  // bounds and the publish counts, so a copy of a check `ruleResults` already
  // publishes is left out. Whatever it holds that no rule does stays.
  const published = new Set<string>();
  for (const rule of rules) {
    for (const unit of rule.kept) if (unit.key !== undefined) published.add(unit.key);
  }
  const siteOriginals = Array.isArray(report.siteChecks) ? report.siteChecks : [];
  const siteUnits = boundChecks(siteOriginals)
    .map((check, order) => {
      const original = siteOriginals[order]!;
      return unitOf("", check, order, affectedBeforeBounds([original], check), siteCheckKey(original, check));
    })
    .filter((unit) => !published.has(unit.key!));

  const {
    pages: _pages,
    ruleResults: _ruleResults,
    siteChecks: _siteChecks,
    entityMap: _entityMap,
    rulesCache: _rulesCache,
    checkTallies: _checkTallies,
    rulePageCounts: _rulePageCounts,
    linkTargetSets: _linkTargetSets,
    detail: _detail,
    resolutionSignal: _resolutionSignal,
    resolutionSignalCompact: _resolutionSignalCompact,
    pageStatuses: _pageStatuses,
    ...rest
  } = report;
  const sections = (mode: SectionMode): Loose => ({
    ...rest,
    pages: [],
    ...("summary" in report
      ? { summary: capSummary(report.summary, mode === "normal" ? PUBLISH_LIMITS.maxSummary : 0) }
      : {}),
    ...("sitemaps" in report ? { sitemaps: capSitemaps(report.sitemaps, mode) } : {}),
    ...("robotsTxt" in report ? { robotsTxt: capRobotsTxt(report.robotsTxt, mode) } : {}),
    ...("resourceSizes" in report
      ? { resourceSizes: capResourceSizes(report.resourceSizes, mode) }
      : {}),
    ...("sitemapUrlStatuses" in report
      ? {
          sitemapUrlStatuses: sliceList(
            report.sitemapUrlStatuses,
            mode === "normal" ? PUBLISH_LIMITS.maxSitemapUrls : 0,
          ),
        }
      : {}),
    checkTallies,
    ...(Object.keys(rulePageCounts).length > 0 ? { rulePageCounts } : {}),
    ...(Object.keys(linkTargetSets).length > 0 ? { linkTargetSets } : {}),
  });
  const { map: entityMap, failed: entityMapFailed } = slimEntityMap(report.entityMap);
  const tiers = REPORT_CAPS.tiers;
  const countsLevel = tiers.length - 1;

  // The whole body at the full sample, set once step 3 has measured it; stamped
  // on any body the fitter had to reduce, beside the size it reached.
  let fullSampleBytes: number | undefined;
  const pagesCrawled = Array.isArray(report.pages) ? report.pages.length : 0;

  const detailFor = (
    tier: number,
    extra: Partial<PublishedReportDetail> = {},
  ): PublishedReportDetail => ({
    capped: true,
    tier,
    caps: { ...tiers[0]!, classesPerRule: REPORT_CAPS.classesPerRule },
    ...(options.fullDetail ? { fullDetail: options.fullDetail } : {}),
    ...(entityMapFailed ? { entityMapFailed: true as const } : {}),
    ...(tier > 0 && fullSampleBytes !== undefined ? { fullSampleBytes } : {}),
    ...extra,
  });

  // Every body leaves through here, measured whole, transport included: the
  // ceiling is the invariant, checked rather than assumed (module note, step 4).
  // A body past tier 0 says so in `detail`, which the API reports to Sentry
  // (repo#2669), so the capper itself reports nothing.
  const finish = (body: Loose): CappedReport<T> => {
    const out = canonical({
      ...body,
      ...(pageStatuses ? { pageStatuses } : {}),
      ...(resolutionSignalCompact ? { resolutionSignalCompact } : {}),
    });
    const bytes = bytesOf(out);
    if (bytes > ceiling) {
      throw new PublishedReportTooLargeError(bytes, ceiling, largestSections(out), "body", {
        tier: (body.detail as PublishedReportDetail | undefined)?.tier,
        pages: pagesCrawled,
      });
    }
    return out as unknown as CappedReport<T>;
  };

  // Every class the body can carry, in output order: each rule's kept classes,
  // then the site checks. A rule that lost classes carries the stamp on its last.
  interface Slot {
    unit: ClassUnit;
    rule?: FoldedRule;
    stamp: boolean;
  }
  const slots: Slot[] = [];
  for (const rule of rules) {
    rule.kept.forEach((unit, i) => {
      slots.push({ unit, rule, stamp: i === rule.kept.length - 1 && rule.total > rule.kept.length });
    });
  }
  for (const unit of siteUnits) slots.push({ unit, stamp: false });

  // A class sampled at one level, with its size, memoized: the fill prices
  // every class at every level.
  const rendered = slots.map(() => new Array<{ check: CheckResult; bytes: number }>(tiers.length));
  const render = (index: number, level: number): { check: CheckResult; bytes: number } => {
    const memo = rendered[index]![level];
    if (memo) return memo;
    const slot = slots[index]!;
    const tier = tiers[level]!;
    const countsOnly = level === countsLevel;
    const caps = slot.rule ? classCaps(tier, countsOnly) : siteCaps(level, tier, countsOnly);
    let check = sampleCheck(slot.unit.check, caps, slot.unit.affected);
    if (slot.stamp) check = stampChecksTruncated(check, slot.rule!.total);
    const out = { check, bytes: bytesOf(check) };
    rendered[index]![level] = out;
    return out;
  };

  const assemble = (
    levels: number[],
    mode: SectionMode,
    withEntityMap: boolean,
    detail: PublishedReportDetail,
  ): Loose => {
    const ruleResults: Loose = {};
    let index = 0;
    for (const rule of rules) {
      const checks: CheckResult[] = [];
      for (let k = 0; k < rule.kept.length; k++, index++) {
        checks.push(render(index, levels[index]!).check);
      }
      ruleResults[rule.id] = { meta: rule.meta, checks };
    }
    const siteChecks: CheckResult[] = [];
    for (; index < slots.length; index++) siteChecks.push(render(index, levels[index]!).check);
    return {
      ...sections(mode),
      ...(withEntityMap && entityMap ? { entityMap } : {}),
      siteChecks,
      ruleResults,
      detail,
    };
  };

  // 3. Every class at the full sample.
  const first = assemble(
    slots.map(() => 0),
    "normal",
    true,
    detailFor(0),
  );
  const firstBytes = bytesOf(first);
  if (firstBytes <= budget) return finish(first);
  fullSampleBytes = firstBytes + transportBytes;

  // 4. Breadth first, then the same with the display sections at their minimum
  // and no entity map.
  const filled = fill(1, "normal", true) ?? fill(2, "minimal", false);
  if (filled) return finish(filled);

  // 5. Last resort: counts rows admitted by byte budget in priority order. Fits
  // by construction; the empty sections are for a skeleton the minimal ones
  // leave over budget.
  return finish(admitByBudget("minimal") ?? admitByBudget("empty")!);

  /**
   * Every class a counts row, then each a small sample, then the full one,
   * highest priority first, while the budget lasts. A class's row is swapped in
   * place and the separators stay, so sizes add up exactly and each step is
   * priced without rebuilding the body; the body is measured at the end anyway.
   * Undefined when the counts rows alone do not fit.
   */
  function fill(tier: number, mode: SectionMode, withEntityMap: boolean): Loose | undefined {
    const dropped = !withEntityMap && entityMap ? { entityMapDropped: true as const } : {};
    const levels = slots.map(() => countsLevel);
    // Priced with the most digits `classesReduced` can need.
    const base = assemble(
      levels,
      mode,
      withEntityMap,
      detailFor(tier, { classesReduced: slots.length, ...dropped }),
    );
    let room = budget - bytesOf(base);
    if (room < 0) return undefined;
    const order = slots
      .map((_, i) => i)
      .sort((a, b) => compareUnits(slots[a]!.unit, slots[b]!.unit));
    for (let level = countsLevel - 1; level >= 0; level--) {
      for (const i of order) {
        if (levels[i] !== level + 1) continue;
        const delta = render(i, level).bytes - render(i, level + 1).bytes;
        if (delta > room) continue;
        levels[i] = level;
        room -= delta;
      }
    }
    const reduced = levels.filter((level) => level > 0).length;
    const body = assemble(
      levels,
      mode,
      withEntityMap,
      detailFor(tier, { ...(reduced > 0 ? { classesReduced: reduced } : {}), ...dropped }),
    );
    return bytesOf(body) <= budget ? body : undefined;
  }

  /**
   * Counts rows only, admitted in priority order while they fit. Undefined when
   * the skeleton does not fit in `minimal` mode; in `empty` mode that throws.
   */
  function admitByBudget(mode: SectionMode): Loose | undefined {
    const caps = classCaps(tiers[countsLevel]!, true);
    const rows = slots.map((slot) => sampleCheck(slot.unit.check, caps, slot.unit.affected));
    const total = slots.length;
    const extra = (admitted: number): Partial<PublishedReportDetail> => ({
      ...(entityMap ? { entityMapDropped: true as const } : {}),
      ...(admitted > 0 ? { classesReduced: admitted } : {}),
      ...(total - admitted > 0 ? { classesDropped: total - admitted } : {}),
    });
    const build = (admitted: Set<number>, detail: PublishedReportDetail): Loose => {
      const ruleResults: Loose = {};
      let index = 0;
      for (const rule of rules) {
        const checks: CheckResult[] = [];
        for (let k = 0; k < rule.kept.length; k++, index++) {
          if (admitted.has(index)) checks.push(rows[index]!);
        }
        // Every class this rule lost, stamped where a reader of the rule sees it.
        const ruleTotal = Math.max(rule.total, rule.kept.length);
        if (ruleTotal > checks.length && checks.length > 0) {
          checks[checks.length - 1] = stampChecksTruncated(checks[checks.length - 1]!, ruleTotal);
        }
        ruleResults[rule.id] = { meta: rule.meta, checks };
      }
      const siteChecks: CheckResult[] = [];
      for (; index < slots.length; index++) if (admitted.has(index)) siteChecks.push(rows[index]!);
      return { ...sections(mode), siteChecks, ruleResults, detail };
    };

    // The skeleton, priced with the most digits the counts in `detail` can need.
    const skeleton = build(
      new Set(),
      detailFor(3, { ...extra(0), classesReduced: total, classesDropped: total }),
    );
    const skeletonBytes = bytesOf(skeleton);
    let room = budget - skeletonBytes;
    if (room < 0) {
      if (mode !== "empty") return undefined;
      throw new PublishedReportTooLargeError(
        skeletonBytes,
        budget,
        largestSections(skeleton),
        "skeleton",
        { tier: 3, pages: pagesCrawled },
      );
    }
    // A rule's first admitted class also pays for the `checksTruncated` stamp
    // the rule carries if it loses any, so the stamps can never overrun.
    const STAMP_BYTES = 48;
    const stamped = new Set<string>();
    const admitted = new Set<number>();
    const order = slots
      .map((_, i) => i)
      .sort((a, b) => compareUnits(slots[a]!.unit, slots[b]!.unit));
    for (const i of order) {
      const ruleId = slots[i]!.unit.ruleId;
      // +1 for the separating comma.
      const bytes = bytesOf(rows[i]) + 1;
      const stamp = ruleId !== "" && !stamped.has(ruleId) ? STAMP_BYTES : 0;
      if (bytes + stamp > room) continue;
      admitted.add(i);
      if (stamp > 0) stamped.add(ruleId);
      room -= bytes + stamp;
    }
    const body = build(admitted, detailFor(3, extra(admitted.size)));
    const bytes = bytesOf(body);
    if (bytes > budget) {
      if (mode !== "empty") return undefined;
      throw new PublishedReportTooLargeError(bytes, budget, largestSections(body), "skeleton", {
        tier: 3,
        pages: pagesCrawled,
      });
    }
    return body;
  }
}
