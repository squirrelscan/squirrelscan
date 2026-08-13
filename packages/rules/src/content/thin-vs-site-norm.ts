// content/thin-vs-site-norm - word-count outliers judged against the site's own norm (#1362)
//
// Absolute word-count thresholds are wrong on most sites: a 200-word product page
// is fine, a 200-word article on a site whose articles median 1800 is not. So this
// rule never compares against a fixed number. It groups pages by `pageType`,
// computes the median + MAD (median absolute deviation) of `wordCount` per group,
// and flags only the low outliers of a group.
//
// Guards, in the order they matter:
//   1. Site floor (THIN_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Group floor (THIN_NORM_MIN_GROUP_PAGES) - a page type with 3 pages cannot
//      support a distribution; the group is dropped, not guessed at.
//   3. Modal agreement (THIN_NORM_MIN_AGREEMENT) - a group whose pages do not
//      cluster around their own median is legitimately heterogeneous, and nothing
//      in it is a "deviant". Skipping beats accusing a healthy site.
//   4. A robust-z floor AND a relative floor must BOTH be crossed, so a tight
//      distribution (template-uniform pages, MAD ~ 0) cannot make an ordinary
//      sibling look like an outlier.
//
// Precedence over content/word-count (#1362): word-count stays absolute-only and
// owns every page under its `min_words` default; this rule DEFERS to it and never
// considers a page below {@link WORD_COUNT_MIN_WORDS}. Above that floor word-count
// only ever emits pass/info, so the two never both raise a finding on one page.
//
// Dual path: `ctx.siteQuery` streams (pageType, wordCount) straight off
// page_features; the legacy path reads the same two fields from `ctx.site.pages`.
// Both feed ONE accumulator and ONE check builder, so the output is byte-identical
// by construction (same shape as content/duplicate-title, #1021/#1022).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

import { WORD_COUNT_MIN_WORDS } from "./word-count";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const THIN_NORM_MIN_PAGES = 10;

/** Per-`pageType` sample floor. A group under this is dropped, never guessed at. */
export const THIN_NORM_MIN_GROUP_PAGES = 8;

/**
 * Share of a group that must sit inside {@link THIN_NORM_BAND} of its median before
 * the median is treated as that group's norm. Below this the group is genuinely
 * varied and no member is a deviant.
 */
export const THIN_NORM_MIN_AGREEMENT = 0.7;

/** Half-width of the "inside the norm" band, as a share of the group median. */
export const THIN_NORM_BAND = 0.5;

/**
 * A flagged page must be under this share of its group median. Paired with the
 * robust-z test so neither a tight nor a wide distribution can fire on its own.
 */
export const THIN_NORM_MAX_RATIO = 0.5;

/** Robust z (deviations of 1.4826*MAD below the median) a flagged page must clear. */
export const THIN_NORM_MIN_Z = 3;

/**
 * Floor on the robust sigma, as a share of the median. Template-uniform groups have
 * MAD 0, which would otherwise make every sub-median page infinitely deviant.
 */
export const THIN_NORM_SIGMA_FLOOR = 0.1;

/** Share of judged pages that turns the warning into a failure. */
export const THIN_NORM_FAIL_SHARE = 0.2;

/** Caps on reported items / groups, so one rule cannot bloat a report. */
const THIN_NORM_MAX_ITEMS = 10;
const THIN_NORM_MAX_GROUPS = 10;

const CHECK_NAME = "thin-vs-site-norm";

/** MAD -> standard-deviation scaling for a normal distribution. */
const MAD_TO_SIGMA = 1.4826;

/** One page's contribution, from either path. */
interface ThinPageRecord {
  url: string;
  status: number;
  pageType: string | null;
  wordCount: number | null;
}

interface ThinGroup {
  pageType: string;
  urls: string[];
  wordCounts: number[];
}

interface ThinRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  /** Pages that carry a usable (pageType, wordCount) pair. */
  sampleCount: number;
  groups: Map<string, ThinGroup>;
}

interface ThinOutlier {
  url: string;
  pageType: string;
  wordCount: number;
  median: number;
  ratio: number;
}

interface JudgedGroup {
  pageType: string;
  pages: number;
  median: number;
  mad: number;
}

function emptyRollup(): ThinRollup {
  return { pageCount: 0, sampleCount: 0, groups: new Map() };
}

/**
 * Fold one page in. Untyped ("unknown") pages are excluded deliberately: that
 * bucket is a grab-bag of everything the classifier could not place, so its
 * distribution means nothing.
 */
function accumulatePage(rollup: ThinRollup, record: ThinPageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  if (record.wordCount === null || record.wordCount < 0) return;
  const pageType = record.pageType?.trim().toLowerCase();
  if (!pageType || pageType === "unknown") return;

  rollup.sampleCount += 1;
  let group = rollup.groups.get(pageType);
  if (!group) {
    group = { pageType, urls: [], wordCounts: [] };
    rollup.groups.set(pageType, group);
  }
  group.urls.push(record.url);
  group.wordCounts.push(record.wordCount);
}

/** Median of a non-empty list (does not mutate the input). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

/**
 * The rule's full output for one rollup. ONE builder, both paths.
 *
 * `sitePageCount` is the crawl-wide page count: the streaming path takes it from
 * `siteQuery.pageCount()` (which includes rows this rule cannot sample), so the
 * site floor is judged on the crawl, not on the sampled subset.
 */
function buildChecks(rollup: ThinRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < THIN_NORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${THIN_NORM_MIN_PAGES} needed to establish a site norm`
      ),
    ];
  }

  const judged: JudgedGroup[] = [];
  const outliers: ThinOutlier[] = [];
  let judgedPages = 0;

  for (const group of rollup.groups.values()) {
    if (group.wordCounts.length < THIN_NORM_MIN_GROUP_PAGES) continue;

    const med = median(group.wordCounts);
    // A group whose median is 0 has no content to compare against.
    if (med <= 0) continue;

    // Heterogeneous groups have no norm: say nothing rather than pick a side.
    const inBand = group.wordCounts.filter(
      (wc) => Math.abs(wc - med) <= THIN_NORM_BAND * med
    ).length;
    if (inBand / group.wordCounts.length < THIN_NORM_MIN_AGREEMENT) continue;

    const mad = median(group.wordCounts.map((wc) => Math.abs(wc - med)));
    const sigma = Math.max(MAD_TO_SIGMA * mad, THIN_NORM_SIGMA_FLOOR * med);
    const zFloor = med - THIN_NORM_MIN_Z * sigma;

    judged.push({ pageType: group.pageType, pages: group.wordCounts.length, median: med, mad });
    judgedPages += group.wordCounts.length;

    for (const [i, wordCount] of group.wordCounts.entries()) {
      // content/word-count owns everything under its absolute floor.
      if (wordCount < WORD_COUNT_MIN_WORDS) continue;
      if (wordCount >= THIN_NORM_MAX_RATIO * med || wordCount >= zFloor) continue;
      outliers.push({
        url: group.urls[i]!,
        pageType: group.pageType,
        wordCount,
        median: med,
        ratio: wordCount / med,
      });
    }
  }

  if (judged.length === 0) {
    return [
      skip(
        `No page type has ${THIN_NORM_MIN_GROUP_PAGES}+ comparable pages with a clear word-count norm`
      ),
    ];
  }

  judged.sort((a, b) => (a.pageType < b.pageType ? -1 : a.pageType > b.pageType ? 1 : 0));
  const typeSummary = judged
    .slice(0, THIN_NORM_MAX_GROUPS)
    .map((g) => `${g.pageType} ${Math.round(g.median)}`)
    .join(", ");
  const details: Record<string, unknown> = {
    judgedPages,
    judgedTypes: judged.length,
    flaggedPages: outliers.length,
    norms: judged.slice(0, THIN_NORM_MAX_GROUPS).map((g) => ({
      pageType: g.pageType,
      pages: g.pages,
      medianWords: g.median,
      mad: g.mad,
    })),
  };

  if (outliers.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judgedPages} comparable page(s) sit within their page type's word-count norm (median words: ${typeSummary})`,
        value: judgedPages,
        details,
      },
    ];
  }

  // Worst offenders first; url breaks ties so the list never depends on crawl order.
  outliers.sort((a, b) => a.ratio - b.ratio || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const items: CheckItem[] = outliers.slice(0, THIN_NORM_MAX_ITEMS).map((o) => ({
    id: o.url,
    label: `${o.wordCount} words vs the ${o.pageType} norm of ${Math.round(o.median)} (${Math.round(o.ratio * 100)}%)`,
    sourcePages: [o.url],
    meta: {
      pageType: o.pageType,
      wordCount: o.wordCount,
      medianWords: o.median,
    },
  }));

  const share = outliers.length / judgedPages;
  return [
    {
      name: CHECK_NAME,
      status: share >= THIN_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${outliers.length} of ${judgedPages} page(s) are far shorter than the norm for their page type (median words: ${typeSummary})`,
      value: outliers.length,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1362): read (pageType, wordCount) off the page_features cursor
 * in normalized_url order (== the legacy `site.pages` order). Only the per-group
 * word-count arrays stay resident; no parsed page is held.
 *
 * The site floor is judged on `pageCount()`, which counts page_features rows; the
 * legacy universe additionally carries the error pages v1 appends to `site.pages`.
 * Only a crawl sitting exactly on the floor with non-auditable pages can word the
 * skip differently, and neither path can judge such a crawl anyway. That is a
 * property of this seam shared with every site rule on it (see
 * content/duplicate-title), not something specific to this rule.
 */
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      pageType: row.pageType,
      wordCount: row.wordCount,
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const thinVsSiteNormRule: Rule = {
  meta: {
    id: "content/thin-vs-site-norm",
    name: "Thin Content vs Site Norm",
    description: "Finds pages far shorter than the site's own norm for their page type",
    solution:
      "These pages are much shorter than the other pages of the same type on your own site, which is a stronger thin-content signal than any absolute word count: your articles set the expectation for what an article on this site looks like. Either expand each page to the depth its siblings have, consolidate it into a fuller page, or noindex it if it exists only for navigation. If a page is deliberately short (a stub, a redirect landing page), that is fine - the point is that it does not match what the rest of its page type promises.",
    category: "content",
    scope: "site",
    severity: "warning",
    // Deliberately light: one site-wide check, capped items, so a single rule
    // cannot dominate the content category score.
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery);
    }

    const pages = ctx.site?.pages;
    if (!pages || pages.length === 0) {
      return { checks: [skip("No pages available for analysis")] };
    }

    const rollup = emptyRollup();
    for (const page of pages) {
      accumulatePage(rollup, {
        url: page.url,
        status: page.statusCode,
        pageType: page.parsed?.pageType ?? null,
        wordCount: page.parsed?.content?.wordCount ?? null,
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
