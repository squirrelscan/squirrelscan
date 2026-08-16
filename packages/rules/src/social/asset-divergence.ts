// social/asset-divergence - site-chrome assets that disagree across the corpus (#1371)
//
// The favicon, the `theme-color` and the fallback OG image all come from ONE
// layout, so on a healthy site every page carries the same three. A page that
// carries a different one is not expressing a per-page decision, it is running a
// different (usually older) template: the fingerprint of a half-finished
// redesign, a stale cached shell, or a section that never got migrated. Nothing
// about that page is wrong when you look at it alone, which is why no per-page
// rule can see it, and why link previews then degrade inconsistently.
//
// Three axes, each judged against the site's OWN modal value:
//   favicon      the primary `<link rel="icon">` href, resolved absolute
//   theme-color  `<meta name="theme-color">` content
//   og-image     the DEFAULT `og:image` — see the exclusion below
//
// The OG exclusion is the whole reason this rule can exist: articles and
// products SHOULD ship their own share image, so those page types never vote on
// the OG axis and are never deviants on it. Page type alone is not enough —
// replaying this rule over stored crawls turned up sites shipping a bespoke
// preview image on pages the classifier calls "unknown" — so an og:image carried
// by exactly ONE page is dropped from that axis too: a fallback is by definition
// shared, while a stale template always brings its whole pocket of pages with
// it. What is judged there is the fallback the rest of the site shares. Favicon
// and theme-color have no such exemption: they are browser chrome, not content,
// and are globally uniform on every correctly built site.
//
// Guards, in the order they matter:
//   1. Site floor (ASSET_NORM_MIN_PAGES) - a small crawl has no norm to speak of.
//   2. Per-axis sample floor (ASSET_NORM_MIN_SAMPLE) - too few pages DECLARE the
//      asset to vote on it. A page that declares nothing never votes and is never
//      a deviant: a missing favicon belongs to core/favicon and a missing
//      og:image to the og-tags rules, so this rule never double-accuses.
//   3. Modal agreement (ASSET_NORM_MIN_AGREEMENT) - an axis whose values do not
//      concentrate on one form is a site that legitimately varies it, and nothing
//      in it is a deviant. Skipping beats accusing a healthy site.
// An axis that clears all three is judged; the rule reports only when at least
// one does, and stays silent (skipped) when none do.
//
// Dual path: `ctx.siteQuery` streams (normalizedUrl, status, pageType, the three
// asset scalars) straight off page_features; the legacy path re-derives them from
// `ctx.site.pages` through the SAME extractor (`extractSiteChromeSignal`, which
// `extractPageFeatures` also calls to populate those columns). Both feed ONE
// accumulator and ONE check builder, and every list is sorted before it is
// emitted, so the output is byte-identical by construction and independent of
// crawl order (same shape as content/duplicate-title, #1021/#1022).

import type { Rule, RuleContext, RuleResult, CheckResult, ParsedPage } from "../types";
import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";

import { getAttrCI } from "@squirrelscan/utils";

/** Crawl-wide page floor: below this there is no site norm to judge against. */
export const ASSET_NORM_MIN_PAGES = 10;

/** Pages that must DECLARE an asset before that axis is judged at all. */
export const ASSET_NORM_MIN_SAMPLE = 10;

/**
 * Share of declaring pages that must carry the same value before it is treated
 * as the site's norm. Below this the site genuinely varies the asset and no page
 * deviates from anything.
 */
export const ASSET_NORM_MIN_AGREEMENT = 0.7;

/** Share of judged pages that turns the warning into a failure. */
export const ASSET_NORM_FAIL_SHARE = 0.2;

/** Caps on reported items / urls, so one rule cannot bloat a report. */
const ASSET_NORM_MAX_ITEMS = 10;
const ASSET_NORM_MAX_URLS = 10;

const CHECK_NAME = "asset-divergence";

/**
 * Per-page cap on each carried value — bounds the stored `page_features` row.
 * A longer value (a big inline `data:` favicon) is truncated, so two distinct
 * values sharing a 200-char prefix compare EQUAL and the divergence is missed.
 * Deliberately the safe direction: the rule never invents a finding, and a
 * report that names a 4KB data URI helps nobody anyway.
 */
export const SITE_CHROME_MAX_VALUE_CHARS = 200;

/**
 * Page types that SHOULD carry their own share image. They neither vote on the
 * og-image axis nor are judged by it — a per-page OG image is correct behavior,
 * and reporting it would be the expensive kind of wrong. Favicon and theme-color
 * are unaffected: those are chrome, and uniform even on an article.
 */
export const PER_PAGE_OG_PAGE_TYPES: ReadonlySet<string> = new Set([
  "article",
  "product",
  "recipe",
  "event",
  "profile",
  "media",
]);

/**
 * `rel` tokens that mark a `<link>` as an alternate/platform icon rather than
 * THE favicon. Apple touch icons and mask icons legitimately differ from the tab
 * icon, so they never stand in for it.
 */
const NON_FAVICON_REL_TOKENS = new Set([
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "fluid-icon",
]);

/** One page's site-chrome assets, absent fields left null. */
export interface SiteChromeSignal {
  /** Absolute URL of the page's primary `<link rel="icon">`, or null. */
  faviconHref: string | null;
  /** `<meta name="theme-color">` content, lowercased, or null. */
  themeColor: string | null;
  /** Absolute URL of the page's `og:image`, or null. */
  ogImage: string | null;
}

export function emptySiteChromeSignal(): SiteChromeSignal {
  return { faviconHref: null, themeColor: null, ogImage: null };
}

/** Trimmed, whitespace-collapsed, capped. Empty reads back as null. */
function bounded(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, SITE_CHROME_MAX_VALUE_CHARS);
}

/**
 * Resolve `value` against the page URL so a site-root reference ("/favicon.ico")
 * compares equal from every depth. An unresolvable value is carried verbatim —
 * comparing the raw forms is still the right answer, and dropping it would hide
 * a page whose markup is broken in a way the others' is not.
 */
function absolute(value: string | null, baseUrl: string): string | null {
  if (value === null) return null;
  try {
    return bounded(new URL(value, baseUrl).href);
  } catch {
    return value;
  }
}

/** `rel` token list of a `<link>`, lowercased. */
function relTokens(el: Element): string[] {
  return (getAttrCI(el, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The page's primary favicon: the first `<link>` in document order whose `rel`
 * carries the `icon` token and no platform-icon token. Document order is the
 * template's own order, so pages generated from one layout pick the same link
 * every time; a page generated from a DIFFERENT layout is the finding.
 */
function primaryFavicon(doc: Document, baseUrl: string): string | null {
  for (const link of doc.querySelectorAll("link")) {
    const tokens = relTokens(link);
    if (!tokens.includes("icon")) continue;
    if (tokens.some((token) => NON_FAVICON_REL_TOKENS.has(token))) continue;
    const href = bounded(getAttrCI(link, "href"));
    if (href !== null) return absolute(href, baseUrl);
  }
  return null;
}

/**
 * The page's theme-color. A light/dark pair (two `<meta>`s scoped by `media`) is
 * normal and MUST NOT read as drift, so the unscoped declaration wins and a
 * media-scoped-only page falls back to its first declaration — the same choice
 * on every page of a site that ships the pair.
 */
function declaredThemeColor(doc: Document): string | null {
  let fallback: string | null = null;
  for (const meta of doc.querySelectorAll("meta")) {
    if ((getAttrCI(meta, "name") ?? "").toLowerCase() !== "theme-color") continue;
    const content = bounded(getAttrCI(meta, "content"));
    if (content === null) continue;
    if (getAttrCI(meta, "media") === null) return content.toLowerCase();
    if (fallback === null) fallback = content.toLowerCase();
  }
  return fallback;
}

/**
 * Read one page's site-chrome assets. Pure + synchronous, exported because it has
 * TWO callers that must agree byte-for-byte: this rule's legacy `ctx.site.pages`
 * path reads it live, and `extractPageFeatures` (audit-engine) stores its output
 * into `page_features` for the streaming path. Same code, one definition.
 *
 * `baseUrl` is the page's stored identity URL (`PageRecord.normalizedUrl`, which
 * is also what `site.pages[].url` carries), so both paths resolve against the
 * same base. `og:image` comes off the parsed scalar rather than the DOM, so it
 * survives on a page whose document was released.
 */
export function extractSiteChromeSignal(
  parsed: ParsedPage | null | undefined,
  baseUrl: string
): SiteChromeSignal {
  const signal = emptySiteChromeSignal();
  if (!parsed) return signal;

  signal.ogImage = absolute(bounded(parsed.og?.image), baseUrl);

  const doc = parsed.document;
  if (!doc) return signal;

  signal.faviconHref = primaryFavicon(doc, baseUrl);
  signal.themeColor = declaredThemeColor(doc);
  return signal;
}

/** One page's contribution, from either path. */
interface ChromePageRecord {
  url: string;
  status: number;
  pageType: string | null;
  chrome: SiteChromeSignal;
}

/** A 2xx page the rule can judge. */
interface ChromeSample {
  url: string;
  /** True when this page type legitimately ships its own OG image. */
  perPageOg: boolean;
  chrome: SiteChromeSignal;
}

interface ChromeRollup {
  /** Pages seen by the rule (both paths count the same universe). */
  pageCount: number;
  samples: ChromeSample[];
}

type AxisKey = "favicon" | "theme-color" | "og-image";

interface Axis {
  key: AxisKey;
  /** Reported name of the asset. */
  label: string;
  /** Verb phrase used in an item label ("... 3 page(s) <verb> "x""). */
  verb: string;
  value: (sample: ChromeSample) => string | null;
  /** Whether this page is allowed to vote on / be judged by the axis at all. */
  eligible: (sample: ChromeSample) => boolean;
  /**
   * Drop values carried by exactly ONE page before judging. A fallback is by
   * definition shared, so a one-off value is a per-page asset, not a template
   * running behind — and page type is not enough to spot one (plenty of sites
   * ship a bespoke preview image on pages the classifier calls "unknown", found
   * replaying this rule over stored crawls). A stale template always brings its
   * whole pocket of pages with it, so it survives this filter.
   */
  dropSingletons?: boolean;
}

/** Fixed axis order — the report's item order never depends on crawl order. */
const AXES: readonly Axis[] = [
  {
    key: "favicon",
    label: "favicon",
    verb: "load favicon",
    value: (s) => s.chrome.faviconHref,
    eligible: () => true,
  },
  {
    key: "theme-color",
    label: "theme-color",
    verb: "declare theme-color",
    value: (s) => s.chrome.themeColor,
    eligible: () => true,
  },
  {
    key: "og-image",
    label: "default OG image",
    verb: "fall back to OG image",
    value: (s) => s.chrome.ogImage,
    eligible: (s) => !s.perPageOg,
    dropSingletons: true,
  },
];

/** A judged axis: its modal value plus the pages that disagree with it. */
interface AxisVerdict {
  axis: Axis;
  norm: string;
  /** Urls of the pages that declared the asset and were eligible to vote. */
  judged: string[];
  /** `judged.length`, carried for the item labels. */
  voters: number;
  /** Pages carrying the modal value. */
  agreeing: number;
  share: number;
  /** url -> the value that page carries, sorted by url. */
  deviants: Array<{ url: string; value: string }>;
}

function emptyRollup(): ChromeRollup {
  return { pageCount: 0, samples: [] };
}

/**
 * Fold one page in. Non-2xx pages carry no template worth comparing (v1 appends
 * 4xx/5xx pages to `site.pages` with an empty parsed record), so they count
 * toward the crawl size but never vote.
 */
function accumulatePage(rollup: ChromeRollup, record: ChromePageRecord): void {
  rollup.pageCount += 1;

  if (record.status < 200 || record.status >= 300) return;
  rollup.samples.push({
    url: record.url,
    perPageOg: PER_PAGE_OG_PAGE_TYPES.has(record.pageType ?? ""),
    chrome: record.chrome,
  });
}

/** The pages an axis judges: eligible, declaring, and (optionally) not one-offs. */
function votersFor(axis: Axis, samples: ChromeSample[]): Array<{ url: string; value: string }> {
  const declared: Array<{ url: string; value: string }> = [];
  const seen = new Map<string, number>();
  for (const sample of samples) {
    if (!axis.eligible(sample)) continue;
    const value = axis.value(sample);
    if (value === null) continue;
    declared.push({ url: sample.url, value });
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  if (!axis.dropSingletons) return declared;
  return declared.filter((voter) => (seen.get(voter.value) ?? 0) > 1);
}

/** Modal value of one axis; ties break lexicographically so order never matters. */
function judgeAxis(axis: Axis, samples: ChromeSample[]): AxisVerdict | null {
  const voters = votersFor(axis, samples);
  const votes = new Map<string, number>();
  for (const voter of voters) votes.set(voter.value, (votes.get(voter.value) ?? 0) + 1);
  if (voters.length < ASSET_NORM_MIN_SAMPLE) return null;

  let best: { value: string; count: number } | null = null;
  for (const [value, count] of votes) {
    if (best === null || count > best.count || (count === best.count && value < best.value)) {
      best = { value, count };
    }
  }
  if (best === null) return null;

  const share = best.count / voters.length;
  if (share < ASSET_NORM_MIN_AGREEMENT) return null;

  const norm = best.value;
  return {
    axis,
    norm,
    judged: voters.map((voter) => voter.url),
    voters: voters.length,
    agreeing: best.count,
    share,
    deviants: voters
      .filter((voter) => voter.value !== norm)
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
  };
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

function pct(share: number): number {
  return Math.round(share * 100);
}

/** Human list ("favicon, theme-color and default OG image"). */
function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The rule's full output for one rollup. ONE builder, both paths.
 *
 * `sitePageCount` is the crawl-wide page count: the streaming path takes it from
 * `siteQuery.pageCount()` (which includes rows this rule cannot sample), so the
 * site floor is judged on the crawl, not on the sampled subset.
 */
function buildChecks(rollup: ChromeRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < ASSET_NORM_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${ASSET_NORM_MIN_PAGES} needed to establish a site-asset norm`
      ),
    ];
  }

  const verdicts = AXES.map((axis) => judgeAxis(axis, rollup.samples)).filter(
    (verdict): verdict is AxisVerdict => verdict !== null
  );

  if (verdicts.length === 0) {
    return [
      skip(
        `No favicon, theme-color or default OG image is declared by ${ASSET_NORM_MIN_SAMPLE} page(s) with ${pct(ASSET_NORM_MIN_AGREEMENT)}% agreement`
      ),
    ];
  }

  // A page is judged once, however many axes it votes on, so the fail threshold
  // measures "how much of the site runs the wrong template" rather than counting
  // one stale layout three times.
  const judgedPages = new Set<string>();
  const flaggedPages = new Set<string>();
  for (const verdict of verdicts) {
    for (const url of verdict.judged) judgedPages.add(url);
    for (const deviant of verdict.deviants) flaggedPages.add(deviant.url);
  }

  const normSummary = verdicts
    .map((v) => `${v.axis.label} ${pct(v.share)}%`)
    .join(", ");
  const details: Record<string, unknown> = {
    judgedPages: judgedPages.size,
    flaggedPages: flaggedPages.size,
    norms: verdicts.map((v) => ({
      dimension: v.axis.key,
      norm: v.norm,
      pages: v.agreeing,
      agreement: v.share,
    })),
  };

  if (flaggedPages.size === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judgedPages.size} page(s) share the site's ${joinLabels(verdicts.map((v) => v.axis.label))} (${normSummary})`,
        value: judgedPages.size,
        details,
      },
    ];
  }

  // Group by (axis, deviant value) so one finding names one stale template
  // instead of one page.
  const groups: Array<{ axis: Axis; value: string; norm: string; voters: number; urls: string[] }> =
    [];
  for (const verdict of verdicts) {
    const byValue = new Map<string, string[]>();
    for (const deviant of verdict.deviants) {
      const urls = byValue.get(deviant.value);
      if (urls) urls.push(deviant.url);
      else byValue.set(deviant.value, [deviant.url]);
    }
    for (const [value, urls] of byValue) {
      groups.push({
        axis: verdict.axis,
        value,
        norm: verdict.norm,
        voters: verdict.voters,
        urls,
      });
    }
  }

  // Biggest group first; axis order then value break ties, so the list never
  // depends on crawl order.
  const ordered = groups.sort(
    (a, b) =>
      b.urls.length - a.urls.length ||
      AXES.indexOf(a.axis) - AXES.indexOf(b.axis) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
  );

  const items: CheckItem[] = ordered.slice(0, ASSET_NORM_MAX_ITEMS).map((group) => ({
    id: `${group.axis.key}:${group.value}`,
    label: `${group.urls.length} of ${group.voters} page(s) ${group.axis.verb} "${group.value}" but the site norm is "${group.norm}"`,
    sourcePages: group.urls.slice(0, ASSET_NORM_MAX_URLS),
    meta: {
      dimension: group.axis.key,
      value: group.value,
      norm: group.norm,
      pageCount: group.urls.length,
    },
  }));

  const share = flaggedPages.size / judgedPages.size;
  return [
    {
      name: CHECK_NAME,
      status: share >= ASSET_NORM_FAIL_SHARE ? "fail" : "warn",
      message: `${flaggedPages.size} of ${judgedPages.size} page(s) diverge from the site's own ${joinLabels(verdicts.map((v) => v.axis.label))} (${normSummary})`,
      value: flaggedPages.size,
      items,
      details,
    },
  ];
}

/**
 * Streaming path (#1371): read the three asset scalars off the page_features
 * cursor. Only bounded strings stay resident — the same shape
 * content/duplicate-title already holds; no parsed page is kept.
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
      chrome: {
        faviconHref: row.faviconHref,
        themeColor: row.themeColor,
        ogImage: row.ogImage,
      },
    });
  }

  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const assetDivergenceRule: Rule = {
  meta: {
    id: "social/asset-divergence",
    name: "Site Asset Consistency",
    description:
      "Finds pages whose favicon, theme-color or default OG image differs from the rest of the site",
    solution:
      "Your favicon, theme-color and fallback share image come from one layout, so every page should carry the same three. Pages that carry different ones are usually running an older template: a section that missed a redesign, a cached shell, or a second layout nobody remembers owning. The visible cost is inconsistent link previews and a tab icon that changes as visitors move around the site. Fix it where the assets are declared (the shared head partial or theme config) rather than page by page. Per-page share images on articles and products are correct and are not reported here: what this rule compares is the fallback the rest of the site shares.",
    category: "social",
    scope: "site",
    severity: "warning",
    // Deliberately light: one site-wide check, capped items, so a single rule
    // cannot dominate the social category score.
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
        chrome: extractSiteChromeSignal(page.parsed, page.url),
      });
    }

    return { checks: buildChecks(rollup, rollup.pageCount) };
  },
};
