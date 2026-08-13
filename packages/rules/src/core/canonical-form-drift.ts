// core/canonical-form-drift - canonicals that disagree in FORM across the site (#1366)
//
// Every canonical here is individually valid. What is wrong is collective: half
// the site canonicalises to `https://www.example.com/thing/` and half to
// `https://example.com/thing`, so the two halves consolidate onto different
// URLs and the ranking signal splits. No per-page rule can see this - a page
// only knows its own canonical - which is why this is a site-scoped rule.
//
// Precedence (recorded so one root cause is never reported twice):
//   - core/canonical owns VALIDITY of the <link rel=canonical>: missing,
//     relative, unparseable, or pointing somewhere else entirely.
//   - core/canonical-header owns the HTTP `Link: rel="canonical"` header and its
//     agreement with the tag.
//   - this rule owns FORM ONLY, and therefore never even looks at a page whose
//     canonical those two would already have something to say about. A page with
//     no canonical, a relative one, an unparseable one, or one pointing at
//     another registrable host is dropped from the sample before any comparison.
//
// Guards, in the order they matter:
//   1. Site floor (CANONICAL_FORM_MIN_PAGES) - a small crawl has no norm.
//   2. Per-dimension sample floor (CANONICAL_FORM_MIN_SAMPLE) - a dimension only
//      a handful of pages can express is dropped, not guessed at.
//   3. Modal agreement (CANONICAL_FORM_MIN_AGREEMENT) - a dimension needs a clear
//      dominant form before the minority can be called deviant. A site that
//      genuinely mixes forms 50/50 has no norm and produces no finding: that is a
//      judgement call for a human, not an accusation from a rule.
//
// Template-uniform pages are safe by construction: pages from one template emit
// canonicals in one form, so they define the norm rather than deviate from it.
//
// Dual path: `ctx.siteQuery` streams `canonical` straight off page_features; the
// legacy path reads `parsed.meta.canonical` from `ctx.site.pages`. Both feed ONE
// accumulator and ONE check builder, so the output is byte-identical by
// construction (same shape as content/duplicate-title, #1021/#1022). No storage
// schema change: `canonical` is already a stored column.

import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const CANONICAL_FORM_MIN_PAGES = 10;

/** Per-dimension sample floor. A dimension under this is dropped, never guessed at. */
export const CANONICAL_FORM_MIN_SAMPLE = 10;

/**
 * Share of a dimension's sample that must agree on one form before the remainder
 * is treated as drift. Below this the site has no established convention and
 * skipping beats accusing it.
 */
export const CANONICAL_FORM_MIN_AGREEMENT = 0.7;

/** Share of judged pages that turns the warning into a failure. */
export const CANONICAL_FORM_FAIL_SHARE = 0.2;

/** Caps on reported drifts / summarized norms, so one rule cannot bloat a report. */
const CANONICAL_FORM_MAX_ITEMS = 10;

/** Cap on URLs listed per drift, so one broken template cannot spray a report. */
const CANONICAL_FORM_MAX_URLS_PER_ITEM = 20;

const CHECK_NAME = "canonical-form-drift";

/**
 * Query keys that carry no page identity. A canonical retaining one of these is
 * the classic "we canonicalised the tracked URL" mistake; the point of the
 * dimension is that a site should do the same thing on every page.
 *
 * Deliberately NOT "does the canonical have any query string at all": pagination
 * and faceted canonicals (`?page=2`) legitimately vary page by page, so presence
 * of a query is a per-page property, not a site-wide form choice. Comparing it
 * across pages would flag every healthy paginated site.
 */
const TRACKING_PARAM_PREFIXES = ["utm_", "mc_"];
const TRACKING_PARAM_NAMES = new Set([
  "_ga",
  "fbclid",
  "gclid",
  "igshid",
  "mkt_tok",
  "msclkid",
  "ref",
  "source",
  "ttclid",
  "yclid",
]);

/** The form axes compared across the site, in report order. */
const DIMENSIONS = ["scheme", "host", "trailing slash", "tracking params"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** One page's contribution, from either path. */
interface CanonicalPageRecord {
  url: string;
  status: number;
  canonical: string | null;
}

interface DimensionSample {
  /** Parallel arrays: the page url and the form it expressed on this axis. */
  urls: string[];
  forms: string[];
}

interface CanonicalRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  /** Pages with a canonical this rule is allowed to compare (see precedence). */
  sampleUrls: string[];
  samples: Map<Dimension, DimensionSample>;
}

/** One "N of M canonicals use X, these N use Y" finding. */
interface FormDrift {
  dimension: Dimension;
  norm: string;
  deviant: string;
  have: number;
  total: number;
  deviantUrls: string[];
}

interface JudgedDimension {
  dimension: Dimension;
  pages: number;
  norm: string;
}

function emptyRollup(): CanonicalRollup {
  const samples = new Map<Dimension, DimensionSample>();
  for (const dimension of DIMENSIONS) samples.set(dimension, { urls: [], forms: [] });
  return { pageCount: 0, sampleUrls: [], samples };
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isTrackingParam(key: string): boolean {
  const name = key.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(name)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The trailing-slash axis only exists where the page had a choice. The site root
 * is always "/", and a path whose last segment looks like a file
 * (`/whitepaper.pdf`, `/index.html`) never carries one, so both are excluded
 * rather than counted as "no trailing slash" and dragged into the norm.
 */
function slashForm(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (last.includes(".")) return null;
  return pathname.endsWith("/") ? "trailing slash" : "no trailing slash";
}

/**
 * Fold one page in. Anything core/canonical or core/canonical-header would
 * already report is dropped here: this rule never doubles up on their findings.
 */
function accumulatePage(rollup: CanonicalRollup, record: CanonicalPageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  const canonical = record.canonical?.trim();
  // Missing / relative / unparseable canonicals belong to core/canonical.
  if (!canonical || !/^https?:\/\//i.test(canonical)) return;

  let target: URL;
  let page: URL;
  try {
    target = new URL(canonical);
    page = new URL(record.url);
  } catch {
    return;
  }

  // Cross-host canonicals belong to core/canonical too, and their form follows
  // whatever conventions the OTHER site keeps - comparing it here is meaningless.
  if (stripWww(target.hostname.toLowerCase()) !== stripWww(page.hostname.toLowerCase())) {
    return;
  }

  rollup.sampleUrls.push(record.url);
  const push = (dimension: Dimension, form: string | null): void => {
    if (!form) return;
    const sample = rollup.samples.get(dimension)!;
    sample.urls.push(record.url);
    sample.forms.push(form);
  };

  push("scheme", target.protocol === "https:" ? "https" : "http");
  push("host", target.hostname.toLowerCase().startsWith("www.") ? "www" : "apex");
  push("trailing slash", slashForm(target.pathname));
  push(
    "tracking params",
    [...target.searchParams.keys()].some(isTrackingParam)
      ? "tracking params retained"
      : "tracking params stripped"
  );
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
 * site floor is judged on the crawl, not on the comparable subset.
 */
function buildChecks(rollup: CanonicalRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < CANONICAL_FORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${CANONICAL_FORM_MIN_PAGES} needed to establish a canonical-form norm`
      ),
    ];
  }

  const judged: JudgedDimension[] = [];
  const drifts: FormDrift[] = [];
  const deviantPages = new Set<string>();

  for (const dimension of DIMENSIONS) {
    const sample = rollup.samples.get(dimension)!;
    const total = sample.forms.length;
    if (total < CANONICAL_FORM_MIN_SAMPLE) continue;

    const counts = new Map<string, number>();
    for (const form of sample.forms) counts.set(form, (counts.get(form) ?? 0) + 1);

    // The modal form, ties broken by name so the two paths cannot disagree.
    let norm = "";
    let normCount = 0;
    for (const [form, count] of counts) {
      if (count > normCount || (count === normCount && byString(form, norm) < 0)) {
        norm = form;
        normCount = count;
      }
    }
    if (normCount / total < CANONICAL_FORM_MIN_AGREEMENT) continue;

    judged.push({ dimension, pages: total, norm });

    const deviantUrls = new Map<string, string[]>();
    for (const [i, form] of sample.forms.entries()) {
      if (form === norm) continue;
      const url = sample.urls[i]!;
      deviantPages.add(url);
      const urls = deviantUrls.get(form) ?? [];
      urls.push(url);
      deviantUrls.set(form, urls);
    }

    for (const [deviant, urls] of [...deviantUrls.entries()].sort((a, b) =>
      byString(a[0], b[0])
    )) {
      drifts.push({
        dimension,
        norm,
        deviant,
        have: normCount,
        total,
        deviantUrls: urls,
      });
    }
  }

  if (judged.length === 0) {
    return [
      skip(
        `No canonical form is shared by ${Math.round(CANONICAL_FORM_MIN_AGREEMENT * 100)}% of at least ${CANONICAL_FORM_MIN_SAMPLE} comparable pages`
      ),
    ];
  }

  const judgedPages = rollup.sampleUrls.length;
  const normSummary = judged.map((d) => `${d.dimension} ${d.norm}`).join(", ");
  const details: Record<string, unknown> = {
    judgedPages,
    judgedDimensions: judged.length,
    flaggedPages: deviantPages.size,
    norms: judged.map((d) => ({ dimension: d.dimension, pages: d.pages, form: d.norm })),
  };

  if (drifts.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judgedPages} comparable canonical(s) share one form (${normSummary})`,
        value: judgedPages,
        details,
      },
    ];
  }

  // Widest drift first; dimension order then form name break ties so the list
  // never depends on crawl order.
  drifts.sort(
    (a, b) =>
      b.deviantUrls.length - a.deviantUrls.length ||
      DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension) ||
      byString(a.deviant, b.deviant)
  );
  const items: CheckItem[] = drifts.slice(0, CANONICAL_FORM_MAX_ITEMS).map((d) => ({
    id: `${d.dimension}:${d.deviant}`,
    label: `${d.have} of ${d.total} canonicals use ${d.norm}, these ${d.deviantUrls.length} use ${d.deviant}`,
    sourcePages: d.deviantUrls.slice(0, CANONICAL_FORM_MAX_URLS_PER_ITEM),
    meta: {
      dimension: d.dimension,
      norm: d.norm,
      deviant: d.deviant,
      have: d.have,
      total: d.total,
      drifted: d.deviantUrls.length,
    },
  }));

  const share = deviantPages.size / judgedPages;
  return [
    {
      name: CHECK_NAME,
      status: share >= CANONICAL_FORM_FAIL_SHARE ? "fail" : "warn",
      message: `${deviantPages.size} of ${judgedPages} canonical(s) are declared in a different form than the rest of the site (${normSummary})`,
      value: deviantPages.size,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1366): read `canonical` off the page_features cursor in
 * normalized_url order (== the legacy `site.pages` order). Only the per-dimension
 * form strings stay resident; no parsed page is held.
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
      canonical: row.canonical,
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const canonicalFormDriftRule: Rule = {
  meta: {
    id: "core/canonical-form-drift",
    name: "Canonical Form Drift",
    description:
      "Finds canonical URLs that disagree in form (www, scheme, trailing slash, tracking params) across the site",
    solution:
      "Each of these canonicals is valid on its own, but the site does not agree with itself: some pages canonicalise to one URL form and some to another. Search engines treat the two forms as different URLs, so links, crawl budget and ranking signals split between them. Pick one form - the one your redirects already send traffic to - and emit it everywhere: one scheme (https), one host (www or apex, not both), one trailing-slash convention, and never any tracking parameters in the canonical. Canonicals are usually generated in one template or middleware, so this is normally a single fix in the place that builds the URL rather than a per-page edit.",
    category: "core",
    scope: "site",
    severity: "warning",
    // Deliberately light, and one site-wide check with capped items rather than a
    // per-page finding, so this rule cannot dominate the core category score.
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
        canonical: page.parsed?.meta?.canonical ?? null,
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
