// url/slug-convention - URL conventions judged against the site's own norm (#1365)
//
// Every other url rule judges ONE url against a fixed idea of a good url. None of
// them can see that a site is internally inconsistent - half its paths ending in a
// slash and half not, most slugs kebab-case with a pocket of snake_case - which is
// the thing that actually produces duplicate-content and canonical bugs. So the
// *mixing* is the finding here, never an individual url: the rule computes the
// site's own modal convention per dimension and reports only the minority form
// against the dominant one.
//
// Dimensions, each judged independently:
//   site-wide   separator      kebab-case vs snake_case vs camelCase last segment
//   site-wide   case           all-lowercase vs a path carrying uppercase
//   site-wide   trailing-slash present vs absent (extensionless paths only)
//   per pageType  date-in-slug   dated vs undated posts of the same type
//   per pageType  depth          path-segment count within one page type
//
// Guards, in the order they matter:
//   1. Site floor (SLUG_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Sample floor per dimension (SLUG_NORM_MIN_SAMPLE site-wide,
//      SLUG_NORM_MIN_GROUP_PAGES per pageType) - a dimension nobody voted in is
//      dropped, not guessed at.
//   3. Modal agreement (SLUG_NORM_MIN_AGREEMENT) - a dimension whose values do not
//      concentrate on one form is legitimately heterogeneous, and nothing in it is
//      a deviant. Skipping beats accusing a healthy site.
//   Together these mean a site that is UNIFORMLY snake_case, or uniformly
//   slash-terminated, is clean here: there is no minority to report.
//
// Precedence (#1365). The direction of suppression is ONE-WAY: the per-page url
// rules own their pages, and this rule drops any deviant they already flag.
//   - url/lowercase warns on every path containing [A-Z] -> a deviant url with
//     uppercase in its path is dropped from the `case` dimension.
//   - url/hyphens warns on every path containing "_" -> a deviant url with an
//     underscore is dropped from the `separator` dimension.
//   - url/trailing-slash only ever raises on paths with a FILE EXTENSION (an
//     extensionless path gets an `info`), so this rule judges the trailing-slash
//     dimension over extensionless paths only and the two never overlap.
// A dimension whose deviants are wholly suppressed is still reported in the
// message tail + `details.deferredTo`, so the detection stays visible without the
// site being accused twice for one root cause.
//
// Dual path: `ctx.siteQuery` streams (normalizedUrl, pageType) straight off
// page_features; the legacy path reads the same two fields from `ctx.site.pages`.
// Both feed ONE accumulator and ONE check builder, and every list is sorted before
// it is emitted, so the output is byte-identical by construction and independent of
// crawl order (same shape as content/duplicate-title, #1021/#1022).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const SLUG_NORM_MIN_PAGES = 10;

/** Sample floor for a site-wide dimension (pages that actually vote in it). */
export const SLUG_NORM_MIN_SAMPLE = 10;

/** Sample floor for a per-`pageType` dimension. */
export const SLUG_NORM_MIN_GROUP_PAGES = 8;

/**
 * Share of a dimension's pages that must share one value before that value is
 * treated as the norm. Below this the site genuinely mixes and no form is a
 * deviant.
 */
export const SLUG_NORM_MIN_AGREEMENT = 0.7;

/** Share of crawled pages that turns the warning into a failure. */
export const SLUG_NORM_FAIL_SHARE = 0.2;

/** Caps on reported items / urls / norms, so one rule cannot bloat a report. */
const SLUG_NORM_MAX_ITEMS = 10;
const SLUG_NORM_MAX_URLS = 10;
const SLUG_NORM_MAX_NORMS = 10;

const CHECK_NAME = "slug-convention";

/** Dimension ids, in the order they are reported. */
const DIMENSIONS = ["separator", "case", "trailing-slash", "date-in-slug", "depth"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** Dimensions computed per `pageType` rather than across the whole site. */
const PER_TYPE_DIMENSIONS = new Set<Dimension>(["date-in-slug", "depth"]);

/** The per-page rule that already owns a deviant, per dimension. */
const OWNING_PAGE_RULE: Partial<Record<Dimension, string>> = {
  case: "url/lowercase",
  separator: "url/hyphens",
};

const DIMENSION_LABELS: Record<Dimension, string> = {
  separator: "slug word separator",
  case: "URL letter case",
  "trailing-slash": "trailing slash",
  "date-in-slug": "date in slug",
  depth: "path depth",
};

const VALUE_LABELS: Record<string, string> = {
  kebab: "kebab-case",
  snake: "snake_case",
  camel: "camelCase",
  lower: "all-lowercase",
  mixed: "mixed-case",
  slash: "a trailing slash",
  bare: "no trailing slash",
  dated: "a date in the slug",
  undated: "no date in the slug",
};

/**
 * A date embedded in a path: /2026/08/ or /2026-08-13 or -2026-08-13. The year is
 * pinned to 19xx/20xx and the month/day to real ranges so a product slug like
 * `widget-2000-50-black` is not read as a date.
 */
const DATE_IN_PATH =
  /(?:^|[/\-])(?:19|20)\d{2}([/\-])(?:0[1-9]|1[0-2])(?:\1(?:0[1-9]|[12]\d|3[01]))?(?:$|[/\-])/;

/** A path whose last segment looks like a file (…/report.pdf). */
const FILE_EXTENSION = /\.[a-z0-9]{2,5}$/i;

/** One page's contribution, from either path. */
interface SlugPageRecord {
  url: string;
  status: number;
  pageType: string | null;
}

/** One dimension's votes, for the site (`pageType: null`) or for one page type. */
interface DimensionBucket {
  dimension: Dimension;
  pageType: string | null;
  /** value -> urls that voted for it (sorted at judge time). */
  values: Map<string, string[]>;
  total: number;
}

interface SlugRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  /** Pages that carry a parseable url and vote in at least one dimension. */
  sampleCount: number;
  buckets: Map<string, DimensionBucket>;
}

interface JudgedDimension {
  dimension: Dimension;
  pageType: string | null;
  norm: string;
  share: number;
  total: number;
}

interface Deviation {
  dimension: Dimension;
  pageType: string | null;
  value: string;
  norm: string;
  urls: string[];
  /** Pages that voted in this dimension (the denominator the finding quotes). */
  total: number;
}

function emptyRollup(): SlugRollup {
  return { pageCount: 0, sampleCount: 0, buckets: new Map() };
}

/** Path of a url, or null when it cannot be parsed. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return null;
  }
}

/** Non-empty path segments. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Slug style of the last path segment, or null when the segment carries no
 * separator signal at all (a single word, an id, a number) and so cannot vote.
 */
function separatorStyle(segment: string): string | null {
  const stem = segment.replace(FILE_EXTENSION, "");
  if (/[a-z][A-Z]/.test(stem)) return "camel";
  if (stem.includes("_")) return "snake";
  if (stem.includes("-")) return "kebab";
  return null;
}

/** The value this page casts in each dimension (absent key = no vote). */
function dimensionValues(path: string): Partial<Record<Dimension, string>> {
  const values: Partial<Record<Dimension, string>> = {};
  const segments = segmentsOf(path);

  // The root carries no slug, no depth and no meaningful trailing slash.
  if (segments.length === 0) return values;

  const last = segments[segments.length - 1]!;
  const separator = separatorStyle(last);
  if (separator) values.separator = separator;

  values.case = /[A-Z]/.test(path) ? "mixed" : "lower";

  // url/trailing-slash owns extension-bearing paths; this dimension is the
  // extensionless directory-style paths it deliberately leaves as `info`.
  if (!FILE_EXTENSION.test(last)) {
    values["trailing-slash"] = path.endsWith("/") ? "slash" : "bare";
  }

  values["date-in-slug"] = DATE_IN_PATH.test(path) ? "dated" : "undated";
  values.depth = String(segments.length);

  return values;
}

/** True when a per-page url rule already flags this url for this dimension. */
function ownedByPageRule(dimension: Dimension, url: string): boolean {
  const path = pathOf(url);
  if (path === null) return false;
  if (dimension === "case") return /[A-Z]/.test(path);
  if (dimension === "separator") return path.includes("_");
  return false;
}

function bucketKey(dimension: Dimension, pageType: string | null): string {
  return `${dimension} ${pageType ?? "*"}`;
}

/**
 * Fold one page in. Per-type dimensions need a real classification: untyped
 * ("unknown") pages are a grab-bag of everything the classifier could not place,
 * so their depth/date distribution means nothing. They still vote in the
 * site-wide dimensions, which do not care what a page is.
 */
function accumulatePage(rollup: SlugRollup, record: SlugPageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  const path = pathOf(record.url);
  if (path === null) return;

  const values = dimensionValues(path);
  const pageType = record.pageType?.trim().toLowerCase();
  const typed = pageType && pageType !== "unknown" ? pageType : null;

  let voted = false;
  for (const dimension of DIMENSIONS) {
    const value = values[dimension];
    if (value === undefined) continue;

    const perType = PER_TYPE_DIMENSIONS.has(dimension);
    if (perType && typed === null) continue;
    const scope = perType ? typed : null;

    const key = bucketKey(dimension, scope);
    let bucket = rollup.buckets.get(key);
    if (!bucket) {
      bucket = { dimension, pageType: scope, values: new Map(), total: 0 };
      rollup.buckets.set(key, bucket);
    }
    const urls = bucket.values.get(value);
    if (urls) urls.push(record.url);
    else bucket.values.set(value, [record.url]);
    bucket.total += 1;
    voted = true;
  }

  if (voted) rollup.sampleCount += 1;
}

/** Modal value of a bucket; ties break on the value name so order never matters. */
function modalValue(bucket: DimensionBucket): { value: string; count: number } {
  let best: { value: string; count: number } | null = null;
  for (const [value, urls] of bucket.values) {
    if (
      best === null ||
      urls.length > best.count ||
      (urls.length === best.count && value < best.value)
    ) {
      best = { value, count: urls.length };
    }
  }
  // Buckets are only created when a page votes, so `best` is never null here.
  return best!;
}

function valueLabel(dimension: Dimension, value: string): string {
  if (dimension === "depth") return `${value} path segment(s)`;
  return VALUE_LABELS[value] ?? value;
}

function scopeLabel(pageType: string | null): string {
  return pageType === null ? "page(s)" : `${pageType} page(s)`;
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

/** Stable ordering for buckets/norms: dimension order, then page type. */
function compareScope(
  a: { dimension: Dimension; pageType: string | null },
  b: { dimension: Dimension; pageType: string | null }
): number {
  const byDimension = DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension);
  if (byDimension !== 0) return byDimension;
  const at = a.pageType ?? "";
  const bt = b.pageType ?? "";
  return at < bt ? -1 : at > bt ? 1 : 0;
}

/**
 * The rule's full output for one rollup. ONE builder, both paths.
 *
 * `sitePageCount` is the crawl-wide page count: the streaming path takes it from
 * `siteQuery.pageCount()` (which includes rows this rule cannot sample), so the
 * site floor is judged on the crawl, not on the sampled subset.
 */
function buildChecks(rollup: SlugRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < SLUG_NORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${SLUG_NORM_MIN_PAGES} needed to establish a URL convention norm`
      ),
    ];
  }

  const judged: JudgedDimension[] = [];
  const deviations: Deviation[] = [];
  const deferred = new Set<string>();

  const buckets = [...rollup.buckets.values()].sort(compareScope);
  for (const bucket of buckets) {
    const floor =
      bucket.pageType === null ? SLUG_NORM_MIN_SAMPLE : SLUG_NORM_MIN_GROUP_PAGES;
    if (bucket.total < floor) continue;

    const modal = modalValue(bucket);
    const share = modal.count / bucket.total;
    // No dominant form: the site mixes deliberately here, so say nothing.
    if (share < SLUG_NORM_MIN_AGREEMENT) continue;

    judged.push({
      dimension: bucket.dimension,
      pageType: bucket.pageType,
      norm: modal.value,
      share,
      total: bucket.total,
    });

    for (const [value, urls] of bucket.values) {
      if (value === modal.value) continue;
      // The per-page url rule already flags these pages; never accuse twice.
      const kept = urls.filter((url) => !ownedByPageRule(bucket.dimension, url));
      if (kept.length < urls.length) {
        const owner = OWNING_PAGE_RULE[bucket.dimension];
        if (owner) deferred.add(`${bucket.dimension} -> ${owner}`);
      }
      if (kept.length === 0) continue;
      deviations.push({
        dimension: bucket.dimension,
        pageType: bucket.pageType,
        value,
        norm: modal.value,
        urls: kept.sort(),
        total: bucket.total,
      });
    }
  }

  if (judged.length === 0) {
    return [
      skip(
        `No URL convention reaches ${Math.round(SLUG_NORM_MIN_AGREEMENT * 100)}% agreement across enough comparable pages`
      ),
    ];
  }

  const deferredTo = [...deferred].sort();
  const deferredTail = deferredTo.length > 0 ? ` (deferred to ${deferredTo.join(", ")})` : "";
  const normSummary = judged
    .slice(0, SLUG_NORM_MAX_NORMS)
    .map(
      (j) =>
        `${DIMENSION_LABELS[j.dimension]}${j.pageType ? ` [${j.pageType}]` : ""} ${valueLabel(j.dimension, j.norm)} ${Math.round(j.share * 100)}%`
    )
    .join(", ");

  const flaggedUrls = new Set<string>();
  for (const d of deviations) for (const url of d.urls) flaggedUrls.add(url);

  const details: Record<string, unknown> = {
    judgedPages: sitePageCount,
    judgedDimensions: judged.length,
    flaggedPages: flaggedUrls.size,
    norms: judged.slice(0, SLUG_NORM_MAX_NORMS).map((j) => ({
      dimension: j.dimension,
      pageType: j.pageType,
      norm: j.norm,
      pages: j.total,
      agreement: j.share,
    })),
    deferredTo,
  };

  if (deviations.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${sitePageCount} page(s) follow the site's own URL conventions (${normSummary})${deferredTail}`,
        value: sitePageCount,
        details,
      },
    ];
  }

  // Biggest deviant group first; the scope key breaks ties so the list never
  // depends on crawl order.
  deviations.sort(
    (a, b) => b.urls.length - a.urls.length || compareScope(a, b) || (a.value < b.value ? -1 : 1)
  );
  const items: CheckItem[] = deviations.slice(0, SLUG_NORM_MAX_ITEMS).map((d) => ({
    id: `${d.dimension}:${d.pageType ?? "*"}:${d.value}`,
    // Counts, not percentages: one deviant in 200 rounds to "0%", which reads as
    // a bug rather than as the finding.
    label: `${d.urls.length} of ${d.total} ${scopeLabel(d.pageType)} use ${valueLabel(d.dimension, d.value)} but the ${DIMENSION_LABELS[d.dimension]} norm is ${valueLabel(d.dimension, d.norm)}`,
    sourcePages: d.urls.slice(0, SLUG_NORM_MAX_URLS),
    meta: {
      dimension: d.dimension,
      pageType: d.pageType,
      value: d.value,
      norm: d.norm,
      pageCount: d.urls.length,
    },
  }));

  const flaggedShare = flaggedUrls.size / sitePageCount;
  return [
    {
      name: CHECK_NAME,
      status: flaggedShare >= SLUG_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${flaggedUrls.size} of ${sitePageCount} page(s) deviate from the site's own URL conventions (${normSummary})${deferredTail}`,
      value: flaggedUrls.size,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1365): read (normalizedUrl, pageType) off the page_features
 * cursor. Only the per-dimension url lists stay resident; no parsed page is held.
 *
 * The site floor is judged on `pageCount()`, which counts page_features rows; the
 * legacy universe additionally carries the error pages v1 appends to `site.pages`.
 * That is a property of this seam shared with every site rule on it (see
 * content/duplicate-title), not something specific to this rule.
 */
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      pageType: row.pageType,
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const slugConventionRule: Rule = {
  meta: {
    id: "url/slug-convention",
    name: "URL Convention Consistency",
    description: "Finds URLs that break the site's own URL conventions",
    solution:
      "Your site uses more than one URL convention: some paths follow one form and a minority follow another. Mixed conventions are how duplicate-content and canonical bugs start, because /My_Page, /my-page and /my-page/ are three different URLs to a crawler even when they serve the same thing. Pick the dominant form already used by most of your site, migrate the minority onto it, and 301-redirect the old paths so links and rankings follow. If a section deliberately differs (a dated archive, a deeper product tree), that is fine: the point is that a handful of pages should not be the exception.",
    category: "url",
    scope: "site",
    severity: "warning",
    // Deliberately light: one site-wide check, capped items, so a single rule
    // cannot dominate the url category score.
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
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
