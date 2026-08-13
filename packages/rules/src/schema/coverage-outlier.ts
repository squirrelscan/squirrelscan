// schema/coverage-outlier - pages missing the structured data their same-type siblings have (#1363)
//
// "This page has no schema" is weak advice: plenty of pages legitimately carry
// none. "40 of 45 product pages have Product schema, these 5 do not" is strong
// advice, because the site has already proved it knows how to emit it and simply
// missed some pages. So this rule never asks whether a page has schema in the
// abstract - only whether it breaks the pattern its own siblings established.
//
// Grouping key (#1363, evaluated before fixing the choice): `pageType`, not
// `richResultTypes`. `richResultTypes` is DERIVED from `schemaTypes` - the very
// field being judged - so grouping by it is circular: a product page missing its
// Product markup has an empty `richResultTypes` and lands in a different group
// from the siblings it is supposed to be compared against, where it can never be
// an outlier. `pageType` is independent of the markup (schema signals + URL
// patterns), which is what makes the comparison meaningful. `richResultTypes` is
// still the better *reporting* lens - a missing rich-result-eligible type costs
// real SERP features - so it is carried per gap in `details` rather than dropped.
//
// Guards, in the order they matter:
//   1. Site floor (SCHEMA_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Group floor (SCHEMA_NORM_MIN_GROUP_PAGES) - a page type with 3 pages cannot
//      establish a pattern; the group is dropped, not guessed at.
//   3. Modal agreement (SCHEMA_NORM_MIN_AGREEMENT) - a type only joins a group's
//      norm once most of the group carries it. A site with no schema anywhere, or
//      one whose same-type pages genuinely differ, therefore produces no norm and
//      the rule stays silent. That case belongs to the per-type schema rules
//      (schema/product, schema/article, ...), not to an outlier rule.
//
// Template-uniform pages are safe by construction: pages built from one template
// carry the same `schemaTypes`, so they all sit inside their own norm and none of
// them can be a deviant.
//
// Dual path: `ctx.siteQuery` streams (pageType, schemaTypes, richResultTypes)
// straight off page_features; the legacy path reads the same three fields from
// `ctx.site.pages`. Both feed ONE accumulator and ONE check builder, so the output
// is byte-identical by construction (same shape as content/duplicate-title,
// #1021/#1022). No storage schema change: all three columns already exist.

import { getRichResultTypes } from "@squirrelscan/utils";

import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const SCHEMA_NORM_MIN_PAGES = 10;

/** Per-`pageType` sample floor. A group under this is dropped, never guessed at. */
export const SCHEMA_NORM_MIN_GROUP_PAGES = 8;

/**
 * Share of a page-type group that must carry a schema @type before that type is
 * treated as the group's norm. Below this the group has no established pattern
 * and nothing in it is a deviant - skipping beats accusing a healthy site.
 */
export const SCHEMA_NORM_MIN_AGREEMENT = 0.7;

/** Share of judged pages that turns the warning into a failure. */
export const SCHEMA_NORM_FAIL_SHARE = 0.2;

/** Caps on reported gaps / summarized norms, so one rule cannot bloat a report. */
const SCHEMA_NORM_MAX_ITEMS = 10;
const SCHEMA_NORM_MAX_GROUPS = 10;

/** Cap on URLs listed per gap, so one broken template cannot spray a report. */
const SCHEMA_NORM_MAX_URLS_PER_GAP = 20;

const CHECK_NAME = "coverage-outlier";

/** One page's contribution, from either path. */
interface SchemaPageRecord {
  url: string;
  status: number;
  pageType: string | null;
  schemaTypes: string[];
  richResultTypes: string[];
}

interface SchemaGroup {
  pageType: string;
  urls: string[];
  /** Parallel to `urls`: the lowercased @type keys present on that page. */
  typeKeys: Set<string>[];
  /** Lowercased key -> display casing, first-seen (both paths iterate in url order). */
  display: Map<string, string>;
  /** Lowercased keys that are rich-result eligible on at least one page. */
  richKeys: Set<string>;
}

interface SchemaRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  /** Pages that carry a usable page type. */
  sampleCount: number;
  groups: Map<string, SchemaGroup>;
}

/** One "N of M <type> pages have X, these N do not" finding. */
interface SchemaGap {
  pageType: string;
  schemaType: string;
  richResult: boolean;
  have: number;
  total: number;
  missingUrls: string[];
}

interface JudgedGroup {
  pageType: string;
  pages: number;
  normTypes: string[];
}

function emptyRollup(): SchemaRollup {
  return { pageCount: 0, sampleCount: 0, groups: new Map() };
}

/**
 * Fold one page in. Untyped ("unknown") pages are excluded deliberately: that
 * bucket is a grab-bag of everything the classifier could not place, so its
 * members are not siblings of each other in any useful sense.
 */
function accumulatePage(rollup: SchemaRollup, record: SchemaPageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  const pageType = record.pageType?.trim().toLowerCase();
  if (!pageType || pageType === "unknown") return;

  rollup.sampleCount += 1;
  let group = rollup.groups.get(pageType);
  if (!group) {
    group = { pageType, urls: [], typeKeys: [], display: new Map(), richKeys: new Set() };
    rollup.groups.set(pageType, group);
  }

  const keys = new Set<string>();
  for (const type of record.schemaTypes) {
    const key = type.trim().toLowerCase();
    if (!key) continue;
    keys.add(key);
    if (!group.display.has(key)) group.display.set(key, type.trim());
  }
  for (const type of record.richResultTypes) {
    const key = type.trim().toLowerCase();
    if (key) group.richKeys.add(key);
  }

  group.urls.push(record.url);
  group.typeKeys.push(keys);
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

/** Stable string ordering, so neither path can depend on iteration luck. */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rule's full output for one rollup. ONE builder, both paths.
 *
 * `sitePageCount` is the crawl-wide page count: the streaming path takes it from
 * `siteQuery.pageCount()` (which includes rows this rule cannot sample), so the
 * site floor is judged on the crawl, not on the sampled subset.
 */
function buildChecks(rollup: SchemaRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < SCHEMA_NORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${SCHEMA_NORM_MIN_PAGES} needed to establish a structured-data norm`
      ),
    ];
  }

  const judged: JudgedGroup[] = [];
  const gaps: SchemaGap[] = [];
  const deviantPages = new Set<string>();
  let judgedPages = 0;

  for (const group of rollup.groups.values()) {
    const total = group.urls.length;
    if (total < SCHEMA_NORM_MIN_GROUP_PAGES) continue;

    // The group's modal schema set: every @type most of the group agrees on.
    // Computed per @type rather than by exact-set frequency on purpose - an
    // optional extra (a BreadcrumbList on some pages only) would otherwise
    // shatter the exact-set mode and hide a real Product gap behind it.
    const counts = new Map<string, number>();
    for (const keys of group.typeKeys) {
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const normKeys: string[] = [];
    for (const [key, count] of counts) {
      if (count / total >= SCHEMA_NORM_MIN_AGREEMENT) normKeys.push(key);
    }
    if (normKeys.length === 0) continue;
    normKeys.sort(byString);

    judged.push({
      pageType: group.pageType,
      pages: total,
      normTypes: normKeys.map((key) => group.display.get(key) ?? key),
    });
    judgedPages += total;

    for (const key of normKeys) {
      const missingUrls: string[] = [];
      for (const [i, keys] of group.typeKeys.entries()) {
        if (keys.has(key)) continue;
        missingUrls.push(group.urls[i]!);
        deviantPages.add(group.urls[i]!);
      }
      // A type every page of the group carries has no deviants to report.
      if (missingUrls.length === 0) continue;
      gaps.push({
        pageType: group.pageType,
        schemaType: group.display.get(key) ?? key,
        richResult: group.richKeys.has(key),
        have: total - missingUrls.length,
        total,
        missingUrls,
      });
    }
  }

  if (judged.length === 0) {
    return [
      skip(
        `No page type has ${SCHEMA_NORM_MIN_GROUP_PAGES}+ comparable pages sharing a structured-data pattern`
      ),
    ];
  }

  judged.sort((a, b) => byString(a.pageType, b.pageType));
  const normSummary = judged
    .slice(0, SCHEMA_NORM_MAX_GROUPS)
    .map((g) => `${g.pageType} ${g.normTypes.join("+")}`)
    .join(", ");
  const details: Record<string, unknown> = {
    judgedPages,
    judgedTypes: judged.length,
    flaggedPages: deviantPages.size,
    norms: judged.slice(0, SCHEMA_NORM_MAX_GROUPS).map((g) => ({
      pageType: g.pageType,
      pages: g.pages,
      schemaTypes: g.normTypes,
    })),
  };

  if (gaps.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judgedPages} comparable page(s) carry the structured data their page type establishes (${normSummary})`,
        value: judgedPages,
        details,
      },
    ];
  }

  // Widest gaps first; pageType then schemaType break ties so the list never
  // depends on crawl order.
  gaps.sort(
    (a, b) =>
      b.missingUrls.length - a.missingUrls.length ||
      byString(a.pageType, b.pageType) ||
      byString(a.schemaType, b.schemaType)
  );
  const items: CheckItem[] = gaps.slice(0, SCHEMA_NORM_MAX_ITEMS).map((g) => ({
    id: `${g.pageType}:${g.schemaType}`,
    label: `${g.have} of ${g.total} ${g.pageType} pages have ${g.schemaType} schema, these ${g.missingUrls.length} do not`,
    sourcePages: g.missingUrls.slice(0, SCHEMA_NORM_MAX_URLS_PER_GAP),
    meta: {
      pageType: g.pageType,
      schemaType: g.schemaType,
      richResult: g.richResult,
      have: g.have,
      total: g.total,
      missing: g.missingUrls.length,
    },
  }));

  const share = deviantPages.size / judgedPages;
  return [
    {
      name: CHECK_NAME,
      status: share >= SCHEMA_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${deviantPages.size} of ${judgedPages} page(s) are missing structured data their same-type siblings have (${normSummary})`,
      value: deviantPages.size,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1363): read (pageType, schemaTypes, richResultTypes) off the
 * page_features cursor in normalized_url order (== the legacy `site.pages` order).
 * Only the per-group @type key sets stay resident; no parsed page is held.
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
      schemaTypes: row.schemaTypes,
      richResultTypes: row.richResultTypes,
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const schemaCoverageOutlierRule: Rule = {
  meta: {
    id: "schema/coverage-outlier",
    name: "Structured Data Coverage Outlier",
    description:
      "Finds pages missing the structured data the rest of their page type carries",
    solution:
      "These pages break your own site's pattern: most pages of the same type emit this schema @type and these do not. That is almost always a template or CMS gap rather than a deliberate choice - a product without its Product markup, an article without its Article markup - and it costs those pages the rich results their siblings are eligible for. Find where the working pages get their JSON-LD and make sure the listed pages run through the same path. If a page genuinely should not carry the markup (a discontinued product stub, a landing page filed under the same type), leave it: the point is that it is currently the exception.",
    category: "schema",
    scope: "site",
    severity: "warning",
    // Deliberately light, and one site-wide check with capped items rather than a
    // per-page finding, so this rule cannot dominate the schema category score.
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
      const schemas = page.parsed?.schemas;
      accumulatePage(rollup, {
        url: page.url,
        status: page.statusCode,
        pageType: page.parsed?.pageType ?? null,
        schemaTypes: schemas?.types ?? [],
        // Same derivation page-features stores, so both paths see one value.
        richResultTypes: schemas ? getRichResultTypes(schemas) : [],
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
