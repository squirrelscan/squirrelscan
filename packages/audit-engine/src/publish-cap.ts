// One capper for every published report (squirrelscan/repo#2656).
//
// A published report is a SUMMARY by design: whatever the crawl size and
// whatever fires, its body fits PUBLISHED_REPORT_MAX_BYTES. Both publish
// producers build their body here (the CLI's `slimForPublish`, the cloud
// container's `truncateReportForPublish`), so the two cannot drift, and the API
// can run the same function over a body from a client that predates it.
//
// In order:
//  1. Count what sampling is about to throw away, from the FULL report:
//     `checkTallies` (this run's fresh checks per rule and check name, in the
//     scorer's own units), the unsampled `resolutionSignal`, and `pageStatuses`.
//  2. Fold every rule's issue classes ONCE, one aggregate per (check name,
//     status, provenance, foldKey), and drop the per-page pass rows (their
//     counts are in the tallies). Folding once matters: `foldGroup` appends
//     "(+N more pages)", so folding an aggregate again stacks the suffix.
//  3. Sample each class at REPORT_CAPS.tiers[0] and measure. While the body is
//     over budget, walk down the tiers, then drop the entity map, then empty
//     the display-only sections and admit issue classes by byte budget,
//     highest priority first. That last step fits by construction, so the
//     only refusal is a report whose skeleton alone (score, rule meta, tallies,
//     enrichment sections) is over budget: a typed error naming its sections.
//
// Deterministic (same input, byte-identical output, so the publish content
// hash is stable) and never mutates its input.
//
// Worker-clean: core-contracts, rules/fold, rules/resolution, utils and the
// scorer's tally math only.

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
 * expected: the worst-case fixture test asserts how far from it real shapes
 * are. Carries the largest sections so the cause is visible without the body.
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
 * the rows the capper drops. Carried and unrendered checks are replays of an
 * earlier audit and are left out, as the server's sampled merge leaves them out.
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
        if (check.provenance === "carried" || check.provenance === "unrendered") continue;
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

/** One entry of a rule's published checks, folded once, sampled per tier. */
interface ClassUnit {
  ruleId: string;
  check: CheckResult;
  /** Position in the rule's output, which no cut reorders. */
  order: number;
  /** Findings the class stands for, the size a cut ranks it by. */
  size: number;
  /** Pages the check names before sampling (see sampleCheck). */
  affected: number;
}

function unitOf(
  ruleId: string,
  check: CheckResult,
  order: number,
  affected: number = affectedPageCount(check),
): ClassUnit {
  return { ruleId, check, order, size: occurrencesOf(check), affected };
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
 * One aggregate for a whole issue class. A class of one keeps its check as is:
 * a single per-page check is the truth about one page, and an existing
 * aggregate is already the fold of its class. A class of several is folded
 * from scratch: members in page order, so the aggregate's message and item
 * details come from the same page however the crawl ordered them, and any
 * earlier fold's message suffix stripped first so it cannot stack.
 */
function foldClass(members: CheckResult[]): CheckResult {
  if (members.length === 1) {
    const only = members[0]!;
    if (only.details?.aggregated !== true) return only;
    // An aggregate built elsewhere may list its pages in any order; the sample
    // is its first pages, so put them in the order a fold here would.
    return {
      ...only,
      ...(only.pages ? { pages: [...only.pages].sort() } : {}),
      ...(only.items ? { items: [...only.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) } : {}),
    };
  }
  const clean = [...members].sort(compareMembers).map((check) =>
    check.details?.aggregated === true && FOLD_SUFFIX.test(check.message)
      ? { ...check, message: check.message.replace(FOLD_SUFFIX, "") }
      : check,
  );
  return foldOverflowChecks(clean, { ...DEFAULT_FOLD_LIMITS, maxChecks: 1 })[0]!;
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

function boundChecks(checks: CheckResult[]): CheckResult[] {
  return clampCheckItemsOverflow(
    clampCheckItemIds(clampCheckDetails(clampCheckStrings(checks))),
  );
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
  const units = [
    ...site.map(({ check, original }) => ({ check, affected: affectedBeforeBounds([original], check) })),
    ...folded,
  ].map(({ check, affected }, order) => unitOf(ruleId, check, order, affected));
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

function sampleItem(item: CheckItem, caps: SampleCaps): CheckItem {
  const next: CheckItem = { ...item };
  // A label equal to the id says nothing the id does not (134KB on one real report).
  if (next.label !== undefined && next.label === next.id) delete next.label;
  if (next.snippet !== undefined) next.snippet = clampItemString(next.snippet, caps.messageChars);
  if (next.sourcePages) {
    const unique = [...new Set(next.sourcePages)];
    if (caps.sourcePages <= 0) delete next.sourcePages;
    else next.sourcePages = unique.slice(0, caps.sourcePages);
  }
  return next;
}

/**
 * One check at one tier: page and item samples, with the true totals kept in
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
    const kept = check.items.slice(0, caps.items);
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

/** Top-level `siteChecks` keep the site caps, never more than the tier's own. */
function siteCaps(tierIndex: number, tier: ReportCapTier, countsOnly: boolean): SampleCaps {
  const first = tierIndex === 0;
  return {
    pages: first ? REPORT_CAPS.siteCheckPages : Math.min(REPORT_CAPS.siteCheckPages, tier.pagesPerClass),
    items: first ? REPORT_CAPS.siteCheckItems : Math.min(REPORT_CAPS.siteCheckItems, tier.itemsPerClass),
    sourcePages: tier.sourcePagesPerItem,
    messageChars: tier.messageChars,
    countsOnly,
  };
}

function sampleRule(rule: FoldedRule, kept: ClassUnit[], caps: SampleCaps): CheckResult[] {
  const checks = kept.map((unit) => sampleCheck(unit.check, caps, unit.affected));
  const last = checks.length - 1;
  if (rule.total > kept.length && last >= 0) {
    checks[last] = stampChecksTruncated(checks[last]!, rule.total);
  }
  return checks;
}

// ── Fixed sections ──────────────────────────────────────────────

type Loose = Record<string, unknown>;

function isRecord(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sliceList(value: unknown, max: number): unknown {
  return Array.isArray(value) && value.length > max ? value.slice(0, max) : value;
}

/** Every summary list to the publish sample, and any list inside an entry too. */
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

function capSitemaps(sitemaps: unknown, empty: boolean): unknown {
  if (!isRecord(sitemaps)) return sitemaps;
  const discovered = Array.isArray(sitemaps.discovered) ? sitemaps.discovered : undefined;
  const out: Loose = {
    ...sitemaps,
    ...(discovered
      ? {
          discovered: empty
            ? []
            : discovered.slice(0, REPORT_CAPS.sitemapEntries).map((s: unknown) =>
                isRecord(s)
                  ? {
                      ...s,
                      urls: sliceList(s.urls, REPORT_CAPS.sitemapUrls),
                      childSitemaps: sliceList(s.childSitemaps, REPORT_CAPS.sitemapChildren),
                      errors: sliceList(s.errors, PUBLISH_LIMITS.maxSummary),
                    }
                  : s,
              ),
        }
      : {}),
  };
  const listMax = empty ? 0 : PUBLISH_LIMITS.maxSummary;
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

function capRobotsTxt(robots: unknown, empty: boolean): unknown {
  if (!isRecord(robots)) return robots;
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

function capResourceSizes(resources: unknown, empty: boolean): unknown {
  if (!isRecord(resources)) return resources;
  const out: Loose = {};
  for (const [category, rows] of Object.entries(resources)) {
    out[category] = Array.isArray(rows)
      ? rows.slice(0, empty ? 0 : REPORT_CAPS.resourceRowsPerCategory).map((row: unknown) =>
          isRecord(row) && Array.isArray(row.sourcePages)
            ? { ...row, sourcePages: row.sourcePages.slice(0, REPORT_CAPS.resourceSourcePages) }
            : row,
        )
      : rows;
  }
  return out;
}

function slimEntityMap(map: EntityMap | null | undefined): EntityMap | undefined {
  if (!map) return undefined;
  try {
    return projectEntityMap(
      map,
      { ...ENTITY_MAP_PUBLISH_LIMITS, maxBytes: REPORT_CAPS.entityMapMaxBytes },
      "publish",
    );
  } catch {
    // Derived, report-only data: a map that cannot be projected is left out
    // rather than failing a finished audit's publish.
    return undefined;
  }
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
  const checkTallies = buildCheckTallies(report.ruleResults);
  const transportBytes =
    (resolutionSignal ? bytesOf(resolutionSignal) + 24 : 0) +
    (pageStatuses ? bytesOf(pageStatuses) + 20 : 0);
  const budget =
    maxBytes - REPORT_CAPS.envelopeBytes - Math.min(transportBytes, REPORT_CAPS.signalMaxBytes);

  // 2. Every rule's classes folded once, in rule-id order.
  const rules = ruleIds.map((id) => foldRule(id, report.ruleResults[id]!));
  const siteOriginals = Array.isArray(report.siteChecks) ? report.siteChecks : [];
  const siteUnits = boundChecks(siteOriginals).map((check, order) =>
    unitOf("", check, order, affectedBeforeBounds([siteOriginals[order]!], check)),
  );

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
  const sections = (empty: boolean): Loose => ({
    ...rest,
    pages: [],
    ...("summary" in report
      ? { summary: capSummary(report.summary, empty ? 0 : PUBLISH_LIMITS.maxSummary) }
      : {}),
    ...("sitemaps" in report ? { sitemaps: capSitemaps(report.sitemaps, empty) } : {}),
    ...("robotsTxt" in report ? { robotsTxt: capRobotsTxt(report.robotsTxt, empty) } : {}),
    ...("resourceSizes" in report
      ? { resourceSizes: capResourceSizes(report.resourceSizes, empty) }
      : {}),
    ...("sitemapUrlStatuses" in report
      ? {
          sitemapUrlStatuses: sliceList(
            report.sitemapUrlStatuses,
            empty ? 0 : PUBLISH_LIMITS.maxSitemapUrls,
          ),
        }
      : {}),
    checkTallies,
  });
  const entityMap = slimEntityMap(report.entityMap);
  const tiers = REPORT_CAPS.tiers;

  const detailFor = (tier: number, extra: Partial<PublishedReportDetail> = {}): PublishedReportDetail => ({
    capped: true,
    tier,
    caps: { ...tiers[tier]!, classesPerRule: REPORT_CAPS.classesPerRule },
    ...(options.fullDetail ? { fullDetail: options.fullDetail } : {}),
    ...extra,
  });

  const finish = (body: Loose): CappedReport<T> =>
    canonical({
      ...body,
      ...(pageStatuses ? { pageStatuses } : {}),
      ...(resolutionSignal ? { resolutionSignal } : {}),
    }) as unknown as CappedReport<T>;

  const assemble = (tierIndex: number, withEntityMap: boolean, extra?: Partial<PublishedReportDetail>): Loose => {
    const tier = tiers[tierIndex]!;
    const countsOnly = tier.pagesPerClass === 0 && tier.itemsPerClass === 0;
    const caps = classCaps(tier, countsOnly);
    const ruleResults: Loose = {};
    for (const rule of rules) {
      ruleResults[rule.id] = { meta: rule.meta, checks: sampleRule(rule, rule.kept, caps) };
    }
    const site = siteCaps(tierIndex, tier, countsOnly);
    return {
      ...sections(false),
      ...(withEntityMap && entityMap ? { entityMap } : {}),
      siteChecks: siteUnits.map((unit) => sampleCheck(unit.check, site, unit.affected)),
      ruleResults,
      detail: detailFor(tierIndex, extra),
    };
  };

  // 3. The sample tiers, then without the entity map.
  for (let t = 0; t < tiers.length; t++) {
    const body = assemble(t, true);
    if (bytesOf(body) <= budget) return finish(body);
  }
  const last = tiers.length - 1;
  if (entityMap) {
    const body = assemble(last, false, { entityMapDropped: true });
    if (bytesOf(body) <= budget) return finish(body);
  }

  // 4. Last resort: display-only sections emptied, then every class (counts
  // only) admitted by byte budget in priority order. Fits by construction.
  return finish(admitByBudget());

  function admitByBudget(): Loose {
    const caps = classCaps(tiers[last]!, true);
    const candidates = [
      ...rules.flatMap((rule) => rule.kept),
      ...siteUnits,
    ].map((unit) => {
      const check = sampleCheck(unit.check, caps, unit.affected);
      // +1 for the separating comma.
      return { unit, check, bytes: bytesOf(check) + 1 };
    });
    const total = candidates.length;
    const extra = (dropped: number): Partial<PublishedReportDetail> => ({
      ...(entityMap ? { entityMapDropped: true as const } : {}),
      ...(dropped > 0 ? { classesDropped: dropped } : {}),
    });
    const build = (admitted: Set<ClassUnit>, dropped: number): Loose => {
      const ruleResults: Loose = {};
      for (const rule of rules) {
        const kept = rule.kept.filter((unit) => admitted.has(unit));
        const checks = kept.map((unit) => sampleCheck(unit.check, caps, unit.affected));
        // Every class this rule lost, stamped where a reader of the rule sees it.
        const ruleTotal = Math.max(rule.total, rule.kept.length);
        if (ruleTotal > kept.length && checks.length > 0) {
          checks[checks.length - 1] = stampChecksTruncated(checks[checks.length - 1]!, ruleTotal);
        }
        ruleResults[rule.id] = { meta: rule.meta, checks };
      }
      return {
        ...sections(true),
        siteChecks: siteUnits
          .filter((unit) => admitted.has(unit))
          .map((unit) => sampleCheck(unit.check, caps, unit.affected)),
        ruleResults,
        detail: detailFor(last, extra(dropped)),
      };
    };

    // The skeleton, priced with the most digits `classesDropped` can need.
    const skeleton = build(new Set(), total);
    const skeletonBytes = bytesOf(skeleton);
    let room = budget - skeletonBytes;
    if (room < 0) {
      throw new PublishedReportTooLargeError(skeletonBytes, budget, largestSections(skeleton));
    }
    // A rule's first admitted class also pays for the `checksTruncated` stamp
    // the rule carries if it loses any, so the stamps can never overrun.
    const STAMP_BYTES = 48;
    const stamped = new Set<string>();
    const admitted = new Set<ClassUnit>();
    for (const candidate of [...candidates].sort((a, b) => compareUnits(a.unit, b.unit))) {
      const ruleId = candidate.unit.ruleId;
      const stamp = ruleId !== "" && !stamped.has(ruleId) ? STAMP_BYTES : 0;
      if (candidate.bytes + stamp > room) continue;
      admitted.add(candidate.unit);
      if (stamp > 0) stamped.add(ruleId);
      room -= candidate.bytes + stamp;
    }
    const body = build(admitted, total - admitted.size);
    const bytes = bytesOf(body);
    if (bytes > budget) {
      throw new PublishedReportTooLargeError(bytes, budget, largestSections(body));
    }
    return body;
  }
}
