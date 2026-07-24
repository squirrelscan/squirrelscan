// Shared "pages affected" aggregation for report renderers.
//
// A check can encode the pages it affects in three ways:
//  1. `check.pages` — the canonical page list (page-scope checks).
//  2. An item's `sourcePages` — pages that reference an external resource the
//     item describes (site-scope rules like blocked-links, broken-links,
//     duplicate-title). Here the item `id` is the resource, NOT a page.
//  3. An item's `id` when it is itself a page URL and the item carries no
//     `sourcePages` (e.g. sitemap-4xx / sitemap-coverage, where each item IS
//     an affected page).
//
// Renderers historically counted only (1), so site-scope rules that store
// page references at the item level reported "0 pages affected". This helper
// unions all three sources so the count is correct without double-counting a
// resource URL as a page (case 2 vs case 3 are mutually exclusive per item).

import type { CheckItem, CheckResult } from "./types";
import type { GroupedCheck } from "./grouping";

/** True when `id` looks like a page URL (vs. a resource identifier / label). */
export function isPageUrl(id: string): boolean {
  return id.startsWith("http://") || id.startsWith("https://");
}

/** Add the pages a single item contributes (case 2 or 3) into `acc`. */
function collectItemPages(item: CheckItem, acc: Set<string>): void {
  if (item.sourcePages !== undefined) {
    // Case 2: the item describes a resource; its sourcePages are the affected
    // pages. The item `id` is the resource itself, so it is NOT counted — even
    // when sourcePages is EMPTY (an unattributed resource affects 0 *known*
    // pages; counting its URL as a page would be wrong).
    for (const src of item.sourcePages) acc.add(src);
  } else if (isPageUrl(item.id)) {
    // Case 3: the item IS an affected page (no sourcePages key at all).
    acc.add(item.id);
  }
}

/**
 * True when an item is FULLY redundant with `checkAffectedPages` — case 3
 * (a URL id, no `sourcePages` key at all) is already counted there, so a
 * renderer's separate "items" listing would duplicate the same URL. Case 2
 * (`sourcePages` present, even as an empty array — an unattributed resource)
 * contributes ZERO pages and is NOT redundant: it must keep its own row in
 * the items listing, or it silently disappears from both places (#1136
 * review round 3 — `sourcePages: []` was being conflated with "no
 * sourcePages key" and dropped entirely).
 */
export function isRedundantPageItem(item: { id: string; sourcePages?: string[] }): boolean {
  return isPageUrl(item.id) && item.sourcePages === undefined;
}

/**
 * Unique pages a single check affects (check.pages + item-level pages).
 * Takes only the two fields it reads — callers building a check-like object
 * from a loosely-typed source (grouping.ts's flexible ruleResults union, the
 * API's Zod-inferred check shape) can pass a plain `{pages, items}` literal
 * with no unsafe cast, since it structurally satisfies this narrower type.
 */
export function checkAffectedPages(check: Pick<CheckResult, "pages" | "items">): Set<string> {
  const acc = new Set<string>();
  for (const page of check.pages ?? []) acc.add(page);
  for (const item of check.items ?? []) collectItemPages(item, acc);
  return acc;
}

/** Count of unique pages a single check affects. */
export function checkAffectedPageCount(check: CheckResult): number {
  return checkAffectedPages(check).size;
}

/** A check's affected pages split into a DISPLAY sample + the AUTHORITATIVE total (#1023 R-F). */
export interface AffectedPages {
  /** Example affected-page URLs to show (the union: check.pages + item page-refs). */
  sample: string[];
  /** True total affected pages — carried in `details.pagesTruncated` when the pages
   *  list was sampled/clipped, else the sample size. NOT `sample.length` on a
   *  sampled check (a 600-page rule clipped to 200 must still read "600"). */
  count: number;
  /** count > sample.length — the sample is a subset; render it as EXAMPLES + "N more". */
  hasMore: boolean;
}

/**
 * THE shared affected-pages accessor (#1023 R-F, blueprint §7). Every consumer —
 * the 6 renderers, the API's report-markdown, and both summary builders — reads
 * the affected-page count from HERE so "(N pages)" is authoritative (the true
 * pre-sample total, not the clipped list length) and lists are labeled examples
 * when `hasMore`. Routing all consumers through one accessor kills the count-drift
 * class across the 9 consumers (risk 5).
 *
 * `count` uses `details.pagesTruncated` (the pre-clip page total stamped by the
 * fold/sample passes, preserved-if-larger) — NOT `details.occurrences`, which is
 * a per-page CHECK count (a page with 3 issues = 3 occurrences, 1 page), so it
 * would overstate a PAGES display.
 */
export function affectedPages(
  check: Pick<CheckResult, "pages" | "items" | "details">,
): AffectedPages {
  const sample = Array.from(checkAffectedPages(check));
  const truncated = check.details?.pagesTruncated;
  const count =
    typeof truncated === "number" && truncated > sample.length ? Math.floor(truncated) : sample.length;
  return { sample, count, hasMore: count > sample.length };
}

/** Unique pages affected across every check of a rule. */
export function ruleAffectedPages(checks: CheckResult[]): Set<string> {
  const acc = new Set<string>();
  for (const check of checks)
    for (const page of checkAffectedPages(check)) acc.add(page);
  return acc;
}

/** Count of unique pages affected across every check of a rule. */
export function ruleAffectedPageCount(checks: CheckResult[]): number {
  return ruleAffectedPages(checks).size;
}

/** Rule-level affected-page rollup across a rule's checks (#1306 / #1023 R-F). */
export interface RuleAffectedRollup {
  /** Honest FLOOR for the rule's total affected pages (see `ruleAffectedRollup`). */
  count: number;
  /** `count` is a LOWER BOUND, not exact — render it with a "+" / "at least". */
  hasMore: boolean;
}

/**
 * Rule-header affected-page rollup across a rule's checks (#1306).
 *
 * `count` is `Math.max` of (a) the union of every check's KNOWN sampled pages
 * and (b) each check's authoritative per-check `count`. It is deliberately MAX,
 * never SUM: checks under one rule usually target overlapping page sets, so
 * summing per-check counts would double-count shared pages and OVERSTATE. Max is
 * a sound floor — each check's true page set is a subset of the rule's union, so
 * no single per-check count and no union of known samples can exceed the union.
 *
 * Max CAN understate: two independently-truncated checks with DISJOINT page sets
 * (check A: 400 truncated, check B: 300 disjoint truncated) have a true union up
 * to 700, but max reports 400 — a truncated check's hidden pages can't be deduped
 * against the other checks, so they might all be new. `hasMore` therefore marks
 * `count` as a floor whenever 2+ checks contribute pages AND at least one is
 * truncated. A single check's `count` is authoritative (exact), so a single-check
 * rule never reports `hasMore` even when its sample is clipped — that keeps the
 * rule header consistent with the per-check "of N" display, which treats the same
 * number as exact.
 */
export function ruleAffectedRollup(
  checks: Pick<CheckResult, "pages" | "items" | "details">[],
): RuleAffectedRollup {
  const union = new Set<string>();
  let maxCount = 0;
  let contributing = 0;
  let anyTruncated = false;
  for (const check of checks) {
    const ap = affectedPages(check);
    if (ap.count > 0) contributing += 1;
    if (ap.count > maxCount) maxCount = ap.count;
    if (ap.hasMore) anyTruncated = true;
    for (const page of ap.sample) union.add(page);
  }
  return { count: Math.max(maxCount, union.size), hasMore: contributing >= 2 && anyTruncated };
}

/**
 * Unique pages carried forward (not re-crawled this run) across every check
 * of an already-grouped rule (#1135) — feeds the per-rule rollup, e.g.
 * "28 of 103 pages carried from previous crawls".
 */
export function ruleCarriedPageCount(checks: GroupedCheck[]): number {
  const acc = new Set<string>();
  for (const check of checks) for (const page of check.carriedPages ?? []) acc.add(page);
  return acc.size;
}
