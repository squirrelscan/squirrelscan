// links/nav-set-divergence - pages whose navigation is missing links the rest of the site has
//
// A site's header, navigation and footer links are templated, so nearly every page carries the
// same set. A page that lacks entries the others have is usually a template that dropped part of
// the nav (a landing page built outside the layout, a legacy template, a broken include): the
// visitor, and the crawler, lose the route to those pages from there.
//
// Each page's set is computed once, by pageNavLinkSet, and stored on `page_features.nav_link_set`
// by the streaming engine. Both paths feed ONE accumulator and ONE check builder, so the output
// is byte-identical by construction (same shape as content/voice-consistency).
//
// Guards, in the order they matter:
//   1. Site floor (NAV_MIN_PAGES), then the same floor on pages that carry a comparable set.
//   2. A norm is the set of hrefs on at least NAV_NORM_SHARE of the compared pages, and is only
//      "clear" when NAV_MIN_AGREEMENT of those pages carry all of it. No clear norm, no verdict.
//   3. Section-scoped navigation (a docs sidebar) is compared within the page type: a type with
//      NAV_MIN_GROUP pages is judged against its own norm, or not judged at all when it has none.
//   4. Localized sections (/fr/, /de-at/) are separate partitions: the whole judging below runs
//      within each locale, so a French page is never held to the English nav. A partition under
//      NAV_MIN_GROUP pages is not judged.
//   5. A page's own URL never counts as missing (the active item is often unlinked), and a page
//      whose set is oversized is not compared.

import { createHash } from "node:crypto";

import { normalizeUrl } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { CheckItem, LinkData, NavLinkSet, SiteQuery } from "@squirrelscan/core-contracts";

/** Crawl-wide page floor: below this there is no site navigation to compare against. */
export const NAV_MIN_PAGES = 10;

/** Share of compared pages that must carry a link for it to be part of the norm. */
export const NAV_NORM_SHARE = 0.7;

/** Share of compared pages that must carry the whole norm for the norm to be clear. */
export const NAV_MIN_AGREEMENT = 0.7;

/** Pages of one page type needed before the type is judged against its own norm. */
export const NAV_MIN_GROUP = 5;

/** A flagged page missing at least this share of the norm has largely lost its navigation: fail. */
export const NAV_FAIL_MISSING_SHARE = 0.5;

/** Flagged pages listed as items. */
export const NAV_MAX_ITEMS = 25;

/** Missing hrefs spelled out in one item's label and meta. */
export const NAV_MAX_LISTED_HREFS = 20;

/** Largest set stored in full; a bigger one keeps only its hash and count. */
export const NAV_SET_MAX_HREFS = 200;

/** Longest href kept; a longer one is data, not navigation. */
const NAV_MAX_HREF_LENGTH = 512;

const CHECK_NAME = "nav-set-divergence";
const CHROME_SECTIONS: ReadonlySet<string> = new Set(["header", "navigation", "footer"]);

/**
 * The navigation link set of a parsed page, or null when it carries none. Internal, working links
 * in header/navigation/footer chrome (or, for an old crawl without sections, any chrome link),
 * normalized without fragment or query, deduped and sorted, minus the page's own URL.
 */
export function pageNavLinkSet(
  parsed: { links?: LinkData[] } | null | undefined,
  pageUrl: string,
): NavLinkSet | null {
  const links = parsed?.links;
  if (!Array.isArray(links)) return null;
  const self = normalizeUrl(pageUrl);
  const set = new Set<string>();
  for (const link of links) {
    if (!link.isInternal || link.error) continue;
    const chrome =
      link.section !== undefined ? CHROME_SECTIONS.has(link.section) : link.isChrome === true;
    if (!chrome || !link.url || link.url.length > NAV_MAX_HREF_LENGTH) continue;
    const href = normalizeUrl(link.url);
    if (href !== self) set.add(href);
  }
  if (set.size === 0) return null;
  const hrefs = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    hash: createHash("sha256").update(hrefs.join("\n")).digest("hex").slice(0, 16),
    count: hrefs.length,
    hrefs: hrefs.length <= NAV_SET_MAX_HREFS ? hrefs : [],
  };
}

interface NavPageRecord {
  url: string;
  status: number;
  pageType: string | null;
  nav: NavLinkSet | null;
}

interface ComparedPage {
  url: string;
  self: string;
  hrefs: ReadonlySet<string>;
  pageType: string;
  locale: string;
}

interface NavRollup {
  pages: ComparedPage[];
  hashes: Set<string>;
  oversizedPages: number;
  pagesWithoutNav: number;
}

function emptyRollup(): NavRollup {
  return { pages: [], hashes: new Set(), oversizedPages: 0, pagesWithoutNav: 0 };
}

/** The classifier's "unknown" is the absence of a type, so it must not form a group of its own. */
function groupKey(pageType: string | null): string {
  const key = pageType?.trim().toLowerCase() ?? "";
  return key === "unknown" ? "" : key;
}

const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z0-9]{2,4})?$/i;

/** The locale of a URL: its first path segment when that looks like one (/fr/, /pt-br/), else "". */
function localeKey(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }
  const first = path.split("/")[1] ?? "";
  return LOCALE_SEGMENT.test(first) ? first.toLowerCase().replace("_", "-") : "";
}

function accumulatePage(rollup: NavRollup, record: NavPageRecord): void {
  if (record.status < 200 || record.status >= 300) return;
  const nav = record.nav;
  if (!nav) {
    rollup.pagesWithoutNav += 1;
    return;
  }
  if (nav.hrefs.length === 0) {
    rollup.oversizedPages += 1;
    return;
  }
  rollup.hashes.add(nav.hash);
  rollup.pages.push({
    url: record.url,
    self: normalizeUrl(record.url),
    hrefs: new Set(nav.hrefs),
    pageType: groupKey(record.pageType),
    locale: localeKey(record.url),
  });
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The norm of a set of pages, or null when it is empty or not clearly shared. */
function clearNorm(pages: ComparedPage[]): string[] | null {
  if (pages.length === 0) return null;
  const counts = new Map<string, number>();
  const selfCounts = new Map<string, number>();
  for (const page of pages) {
    for (const href of page.hrefs) counts.set(href, (counts.get(href) ?? 0) + 1);
    selfCounts.set(page.self, (selfCounts.get(page.self) ?? 0) + 1);
  }
  // A page cannot list its own URL (the extractor drops it), so a page sitting on an href counts
  // as having it: otherwise every nav target would drag its own link below the share.
  const norm: string[] = [];
  for (const [href, n] of counts) {
    if ((n + (selfCounts.get(href) ?? 0)) / pages.length >= NAV_NORM_SHARE) norm.push(href);
  }
  if (norm.length === 0) return null;
  norm.sort(byText);
  const agreeing = pages.filter((p) => norm.every((h) => p.hrefs.has(h) || h === p.self)).length;
  return agreeing / pages.length >= NAV_MIN_AGREEMENT ? norm : null;
}

function skip(message: string): CheckResult {
  return { name: CHECK_NAME, status: "skipped", message };
}

interface Flagged {
  url: string;
  missing: string[];
  normSize: number;
  comparedWithin: string;
}

function buildChecks(rollup: NavRollup, sitePageCount: number): CheckResult[] {
  if (sitePageCount < NAV_MIN_PAGES) {
    return [
      skip(
        `Only ${sitePageCount} page(s) crawled; ${NAV_MIN_PAGES} needed to establish the site's navigation`,
      ),
    ];
  }
  const pages = [...rollup.pages].sort((a, b) => byText(a.url, b.url));
  if (pages.length < NAV_MIN_PAGES) {
    return [
      skip(
        `Only ${pages.length} page(s) carry navigation links to compare; ${NAV_MIN_PAGES} needed to establish the site's navigation`,
      ),
    ];
  }

  const partitions = new Map<string, ComparedPage[]>();
  for (const page of pages) {
    const part = partitions.get(page.locale);
    if (part) part.push(page);
    else partitions.set(page.locale, [page]);
  }

  let judged = 0;
  let unjudged = 0;
  let siteNormSize = 0;
  const flagged: Flagged[] = [];
  const judgeAgainst = (group: ComparedPage[], norm: string[], comparedWithin: string): void => {
    for (const page of group) {
      judged += 1;
      const missing = norm.filter((h) => !page.hrefs.has(h) && h !== page.self);
      if (missing.length > 0) {
        flagged.push({ url: page.url, missing, normSize: norm.length, comparedWithin });
      }
    }
  };

  for (const locale of [...partitions.keys()].sort(byText)) {
    const part = partitions.get(locale)!;
    if (part.length < NAV_MIN_GROUP) {
      unjudged += part.length;
      continue;
    }
    const label = locale === "" ? "" : `locale:${locale}`;
    const siteNorm = clearNorm(part);
    if (locale === "") siteNormSize = siteNorm?.length ?? 0;

    const groups = new Map<string, ComparedPage[]>();
    for (const page of part) {
      if (page.pageType === "") continue;
      const group = groups.get(page.pageType);
      if (group) group.push(page);
      else groups.set(page.pageType, [page]);
    }
    const groupNorms = new Map<string, string[] | null>();
    for (const [type, group] of groups) {
      if (group.length >= NAV_MIN_GROUP) groupNorms.set(type, clearNorm(group));
    }

    const rest: ComparedPage[] = [];
    for (const type of [...groups.keys()].sort(byText)) {
      if (!groupNorms.has(type)) {
        rest.push(...groups.get(type)!);
        continue;
      }
      const norm = groupNorms.get(type);
      if (norm)
        judgeAgainst(
          groups.get(type)!,
          norm,
          [label, `pageType:${type}`].filter(Boolean).join(" "),
        );
      else unjudged += groups.get(type)!.length;
    }
    for (const page of part) if (page.pageType === "") rest.push(page);
    if (siteNorm) judgeAgainst(rest, siteNorm, label || "site");
    else unjudged += rest.length;
  }

  if (judged === 0) {
    return [skip("No clear navigation norm: the pages' navigation links do not agree on one set")];
  }

  const details: Record<string, unknown> = {
    judgedPages: judged,
    flaggedPages: flagged.length,
    unjudgedPages: unjudged,
    oversizedPages: rollup.oversizedPages,
    pagesWithoutNav: rollup.pagesWithoutNav,
    distinctNavSets: rollup.hashes.size,
    siteNormSize,
  };

  if (flagged.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "pass",
        message: `All ${judged} judged page(s) carry the site's navigation links`,
        value: judged,
        details,
      },
    ];
  }

  flagged.sort((a, b) => b.missing.length - a.missing.length || byText(a.url, b.url));
  const items: CheckItem[] = flagged.slice(0, NAV_MAX_ITEMS).map((f) => {
    const listed = f.missing.slice(0, NAV_MAX_LISTED_HREFS);
    const more = f.missing.length - listed.length;
    return {
      id: f.url,
      label: `Missing ${f.missing.length} of ${f.normSize} navigation links the rest of the site has: ${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
      sourcePages: [f.url],
      meta: {
        missingHrefs: listed,
        missingCount: f.missing.length,
        normSize: f.normSize,
        comparedWithin: f.comparedWithin,
      },
    };
  });
  const severe = flagged.some((f) => f.missing.length / f.normSize >= NAV_FAIL_MISSING_SHARE);

  return [
    {
      name: CHECK_NAME,
      status: severe ? "fail" : "warn",
      message: `${flagged.length} of ${judged} judged page(s) are missing navigation links the rest of the site has`,
      value: flagged.length,
      items,
      details,
    },
  ];
}

async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const rollup = emptyRollup();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    accumulatePage(rollup, {
      url: row.normalizedUrl,
      status: row.status,
      pageType: row.pageType,
      nav: row.navLinkSet ?? null,
    });
  }
  return { checks: buildChecks(rollup, siteQuery.pageCount()) };
}

export const navSetDivergenceRule: Rule = {
  meta: {
    id: "links/nav-set-divergence",
    name: "Navigation Set Divergence",
    description: "Finds pages whose navigation is missing links the rest of the site has",
    solution:
      "These pages leave out navigation links that most of your site carries, so visitors and crawlers lose the route to those pages from here. Check the page's template: a landing page built outside the shared layout, an older template, or a header or footer include that failed to render are the usual causes. Add the missing links back, or move the page onto the shared layout. If the page is meant to be a focused landing page, this is intended and can stay. Sections with their own navigation (a docs area, a store) are compared with their own page type, not the whole site.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 3,
    // Check names by outcome class (#1741).
    checks: [
      { name: CHECK_NAME, outcome: "problem" },
      { name: CHECK_NAME, outcome: "clean", clears: [CHECK_NAME] },
      { name: CHECK_NAME, outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) return runViaSiteQuery(ctx.siteQuery);

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
        nav: pageNavLinkSet(page.parsed, page.url),
      });
    }
    return { checks: buildChecks(rollup, pages.length) };
  },
};
