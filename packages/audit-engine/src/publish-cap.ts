// One capper for every published report (squirrelscan/repo#2656).
//
// A published report is a SUMMARY by design: whatever fires, everything but the
// scoring transport fits PUBLISHED_REPORT_MAX_BYTES minus that transport's
// reserve. Both publish producers will build their body here (the CLI's
// `slimForPublish`, the cloud container's `truncateReportForPublish`), so the
// two cannot drift, and the API can run the same function over a body from a
// client that predates it.
//
// NOT YET "whatever the crawl size": `resolutionSignal` and `pageStatuses` still
// grow with pages crawled (raw URLs; 1,401KB whole body at 2,000 pages on the
// real-shape fixture), so the whole body fits only once repo#2658 bounds them.
// TODO(repo#2658, repo#2657): do not wire this into either producer until the
// transport is bounded and the server rescore reads `checkTallies`. The wiring
// rebase of repo#2658 tightens the worst-case test to the whole body, which is
// the gate.
//
// In order:
//  1. Count what sampling is about to throw away, from the FULL report:
//     `checkTallies` (this run's fresh checks per rule and check name, in the
//     scorer's own units), the unsampled `resolutionSignal`, and `pageStatuses`.
//  2. Fold every rule's issue classes ONCE, one aggregate per (check name,
//     status, provenance, foldKey), and drop the per-page pass rows (their
//     counts are in the tallies). Folding once matters: `foldGroup` appends
//     "(+N more pages)", so folding an aggregate again stacks the suffix.
//     Each class's page sample leads with the page it hits hardest, and its
//     items are ranked by how many pages they are on. Top-level `siteChecks`
//     entries that repeat a site check of `ruleResults` are left out.
//  3. Sample each class at REPORT_CAPS.tiers[0] and measure. Over budget, fill
//     breadth first: every class gets a counts row, then a small sample, then
//     the full one, highest priority first, while the budget lasts. If the
//     counts rows alone do not fit, the display sections go to their minimum
//     and the entity map is dropped, and the fill runs again. Last, counts rows
//     are admitted by byte budget. That fits by construction, so the only
//     refusal is a report whose skeleton alone (score, rule meta, tallies,
//     enrichment sections) is over budget: a typed error naming its sections.
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
  PublishedReportDetail,
  ResolutionSignal,
  RuleMetaLite,
} from "@squirrelscan/core-contracts";
import { clampItemString } from "@squirrelscan/core-contracts/clamp";
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
  clipPageStatusesToBytes,
  DEFAULT_FOLD_LIMITS,
  foldGroupKey,
  foldOverflowChecks,
  maxChecksTruncated,
  stampChecksTruncated,
  unfoldAggregateCheck,
} from "@squirrelscan/rules/fold";
import { checkAffectedPages } from "@squirrelscan/report/affected-pages";
import { buildResolutionSignal } from "@squirrelscan/rules/resolution";
import { byteLength } from "@squirrelscan/utils/bytes";
import { RULE_ID_ROBOTS_TXT, RULE_ID_SITEMAP_EXISTS } from "@squirrelscan/utils/constants";
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
  resolutionSignal?: ResolutionSignal | null;
  entityMap?: EntityMap | null;
  summary?: unknown;
  sitemaps?: unknown;
  robotsTxt?: unknown;
  resourceSizes?: unknown;
  sitemapUrlStatuses?: unknown;
  rulesCache?: unknown;
  checkTallies?: unknown;
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
  | "detail"
  | "resolutionSignal"
  | "pageStatuses"
> & {
  pages: [];
  ruleResults: Record<string, { meta: CappedRuleMeta; checks: CheckResult[] }>;
  siteChecks: CheckResult[];
  entityMap?: EntityMap;
  checkTallies: CheckTallies;
  detail: PublishedReportDetail;
  resolutionSignal?: ResolutionSignal;
  pageStatuses?: Array<{ url: string; status: number }>;
};

export interface CapReportOptions {
  /** Where the full per-page detail lives, stamped as `detail.fullDetail`. */
  fullDetail?: PublishedReportDetail["fullDetail"];
  /** Whole-body budget, envelope included. Defaults to PUBLISHED_REPORT_MAX_BYTES. */
  maxBytes?: number;
}

/**
 * A report whose skeleton alone (score, rule meta, tallies, enrichment
 * sections) does not fit the budget, after every list has been emptied. Never
 * expected: the worst-case tests assert how far from it real shapes are.
 * Carries the largest sections so the cause is visible without the body.
 */
export class PublishedReportTooLargeError extends Error {
  readonly code = "PUBLISHED_REPORT_TOO_LARGE";
  constructor(
    readonly bytes: number,
    readonly budgetBytes: number,
    readonly largestSections: Record<string, number>,
  ) {
    super(
      `Published report skeleton is ${bytes} bytes, over its ${budgetBytes}-byte budget ` +
        `(largest: ${Object.entries(largestSections)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")})`,
    );
    this.name = "PublishedReportTooLargeError";
  }
}

// ── Tallies ─────────────────────────────────────────────────────

/**
 * This run's fresh evaluated checks per rule and check name (see
 * {@link CheckTally}). Counted over the UNFOLDED checks with the scorer's own
 * `addChecksToTally`, exactly as the server rescore counts a published report
 * today, so a reader that sums them gets the numbers it would have counted from
 * the rows the capper drops. The checks that rescore leaves out are left out
 * here too (repo#2657): page replays (`isReplayedCheck`), and checks on a page
 * that returned 404/410 this run (`removedUrls`, normalized), which it does not
 * score because the page is gone.
 *
 * If the input was itself already sampled (an aggregate whose `pages` is shorter
 * than its `pagesTruncated`), the counts are a floor, same as a rescore of it.
 */
export function buildCheckTallies(
  ruleResults: Record<string, { meta: { severity: string }; checks: CheckResult[] }>,
  removedUrls: ReadonlySet<string> = new Set(),
): CheckTallies {
  const out: CheckTallies = {};
  for (const ruleId of Object.keys(ruleResults).sort()) {
    const rule = ruleResults[ruleId];
    if (!rule || !Array.isArray(rule.checks)) continue;
    const byName = new Map<string, CheckResult[]>();
    for (const original of rule.checks) {
      for (const check of unfoldAggregateCheck(original)) {
        if (isReplayedCheck(check)) continue;
        if (check.pageUrl && removedUrls.size > 0 && removedUrls.has(normalizePageUrl(check.pageUrl))) {
          continue;
        }
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

/** Priority order for any cut: status, then size, then a stable identity. */
function compareUnits(a: ClassUnit, b: ClassUnit): number {
  const pinned = Number(PINNED_RULES.has(b.ruleId)) - Number(PINNED_RULES.has(a.ruleId));
  if (pinned !== 0) return pinned;
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
  return { id: ruleId, meta: capMeta(rule.meta), kept, total };
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

/** The `details` keys that carry a class's true totals and identity. */
const COUNT_KEYS = [
  "aggregated",
  "occurrences",
  "pagesTruncated",
  "additional",
  "checksTruncated",
  "foldKey",
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
  return next;
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
 * Pages that returned 404/410 this run, normalized. The server stales their
 * findings and leaves their checks out of the score (repo#2657), so the tallies
 * do too. Read from the full report, before `pageStatuses` is clipped.
 */
function removedPageUrls(report: CappableReport): Set<string> {
  const out = new Set<string>();
  const add = (url: unknown, status: unknown): void => {
    if (typeof url === "string" && typeof status === "number" && REMOVED_STATUSES.has(status)) {
      out.add(normalizePageUrl(url));
    }
  };
  if (Array.isArray(report.pages)) for (const page of report.pages) add(page?.url, page?.statusCode);
  if (Array.isArray(report.pageStatuses)) {
    for (const row of report.pageStatuses) add(row?.url, row?.status);
  }
  return out;
}

function crawledUrlsOf(pages: CappableReport["pages"]): string[] {
  if (!Array.isArray(pages)) return [];
  const urls: string[] = [];
  for (const page of pages) if (typeof page?.url === "string") urls.push(page.url);
  return urls;
}

/**
 * Non-2xx pages of this run for the server's removed-page detection. A 2xx is
 * implied by the page's checks, so a healthy site sends nothing. Clipped to its
 * share of the transport budget, which only means fewer findings get staled.
 */
function buildPageStatuses(
  report: CappableReport,
): Array<{ url: string; status: number }> | undefined {
  let statuses = Array.isArray(report.pageStatuses) ? report.pageStatuses : undefined;
  if (!statuses && Array.isArray(report.pages)) {
    statuses = [];
    for (const page of report.pages) {
      const url = page?.url;
      const status = page?.statusCode;
      if (typeof url !== "string" || typeof status !== "number") continue;
      if (status >= 200 && status < 300) continue;
      statuses.push({ url, status });
    }
  }
  if (!statuses || statuses.length === 0) return undefined;
  // URL order, so the clip keeps the same pages however the crawl ordered them.
  const sorted = [...statuses].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const holder = { pageStatuses: sorted.slice(0, REPORT_LIMITS.maxPages) };
  clipPageStatusesToBytes(holder, REPORT_CAPS.pageStatusesMaxBytes);
  return holder.pageStatuses.length > 0 ? holder.pageStatuses : undefined;
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

/**
 * The signal in one order whatever order the producer met rules and pages in.
 * Its bounds were applied when it was built; this only sorts what was kept.
 */
function canonicalSignal(signal: ResolutionSignal | null | undefined): ResolutionSignal | undefined {
  if (!signal) return undefined;
  const sortMap = (map: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(
      Object.keys(map)
        .sort()
        .map((key) => [key, [...map[key]!].sort()]),
    );
  return {
    crawledUrls: [...signal.crawledUrls].sort(),
    failing: sortMap(signal.failing),
    ...(signal.notEvaluated ? { notEvaluated: sortMap(signal.notEvaluated) } : {}),
    ...(signal.truncated ? { truncated: [...signal.truncated].sort() } : {}),
  };
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
 * scoring transport (`resolutionSignal`, `pageStatuses`) is sized by pages
 * crawled and cannot be sampled, so it is measured first and the rest of the
 * report gets what it leaves, never less than the budget minus its reserve
 * (REPORT_CAPS.signalMaxBytes). Bounding the transport itself is repo#2658.
 *
 * Throws {@link PublishedReportTooLargeError} only when the skeleton alone does
 * not fit.
 */
export function capReportForPublish<T extends CappableReport>(
  report: T,
  options: CapReportOptions = {},
): CappedReport<T> {
  const maxBytes = options.maxBytes ?? PUBLISHED_REPORT_MAX_BYTES;

  // 1. Counted from the full report, before anything is sampled.
  const ruleIds = Object.keys(report.ruleResults).sort();
  // Built over rules and check names in a fixed order, so the keys its budget
  // keeps do not depend on the order rules ran in.
  const resolutionSignal = canonicalSignal(
    report.resolutionSignal ??
      buildResolutionSignal(
        Object.fromEntries(
          ruleIds.map((id) => {
            const rule = report.ruleResults[id]!;
            const checks = Array.isArray(rule.checks) ? rule.checks : [];
            return [id, { checks: [...checks].sort(compareNames) }];
          }),
        ),
        crawledUrlsOf(report.pages).sort(),
      ),
  );
  const pageStatuses = buildPageStatuses(report);
  const checkTallies = buildCheckTallies(report.ruleResults, removedPageUrls(report));
  const transportBytes =
    (resolutionSignal ? bytesOf(resolutionSignal) + 24 : 0) +
    (pageStatuses ? bytesOf(pageStatuses) + 20 : 0);
  const budget =
    maxBytes - REPORT_CAPS.envelopeBytes - Math.min(transportBytes, REPORT_CAPS.signalMaxBytes);

  // 2. Every rule's classes folded once, in rule-id order.
  const rules = ruleIds.map((id) => foldRule(id, report.ruleResults[id]!));
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
    detail: _detail,
    resolutionSignal: _resolutionSignal,
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
  });
  const { map: entityMap, failed: entityMapFailed } = slimEntityMap(report.entityMap);
  const tiers = REPORT_CAPS.tiers;
  const countsLevel = tiers.length - 1;

  const detailFor = (
    tier: number,
    extra: Partial<PublishedReportDetail> = {},
  ): PublishedReportDetail => ({
    capped: true,
    tier,
    caps: { ...tiers[0]!, classesPerRule: REPORT_CAPS.classesPerRule },
    ...(options.fullDetail ? { fullDetail: options.fullDetail } : {}),
    ...(entityMapFailed ? { entityMapFailed: true as const } : {}),
    ...extra,
  });

  const finish = (body: Loose): CappedReport<T> =>
    canonical({
      ...body,
      ...(pageStatuses ? { pageStatuses } : {}),
      ...(resolutionSignal ? { resolutionSignal } : {}),
    }) as unknown as CappedReport<T>;

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
  if (bytesOf(first) <= budget) return finish(first);

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
      throw new PublishedReportTooLargeError(skeletonBytes, budget, largestSections(skeleton));
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
      throw new PublishedReportTooLargeError(bytes, budget, largestSections(body));
    }
    return body;
  }
}
