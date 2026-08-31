// crawl/sitemap-lastmod-drift - Sitemap lastmod vs the page's own dateModified

import { z } from "zod";

import type { ParsedPage, Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { SitemapData } from "@squirrelscan/core-contracts";

import { flattenJsonLdNodes, normalizeUrl } from "@squirrelscan/utils";

import { documentTypes, isArticleType, schemaDateString } from "../shared/schema-document";

const MS_PER_DAY = 86_400_000;

// Findings are capped so a site whose whole sitemap is build-stamped reports a
// readable sample rather than thousands of items; `details.total` keeps the
// real count.
const MAX_ITEMS = 50;

export const optionsSchema = z.object({
  ahead_days: z
    .number()
    .default(30)
    .describe("Days a sitemap lastmod may run ahead of the page's own dateModified before warning"),
  behind_days: z
    .number()
    .default(7)
    .describe("Days a sitemap lastmod may lag the page's own dateModified before warning"),
});

/** Where a page's own date came from — reported so a fix targets the right markup. */
type DateSource = "schema" | "meta" | "visible";

interface PageDate {
  value: string;
  ms: number;
  source: DateSource;
}

/** Parse a date string to epoch ms, or null when it isn't a usable date. */
function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

const isUsableDate = (value: string): boolean => parseDate(value) !== null;

/**
 * The `dateModified` of the JSON-LD node that describes THIS DOCUMENT.
 *
 * Nodes for things the page merely mentions are ignored: a sitewide
 * `WebSite`/`Organization` node carries its own stale `dateModified`, and Yoast
 * and Rank Math emit it FIRST in `@graph`, ahead of the `Article`. Reading the
 * first dated node made the verdict depend on `@graph` order — the same trap
 * `content/date-agreement` guards with the shared `documentTypes` (#1570).
 *
 * Selection is position-independent: an Article-family node wins wherever it
 * sits, since the post's own node speaks for the content, and a node claiming
 * both (`["WebPage", "BlogPosting"]`) counts as the article whichever half was
 * written first. Among nodes of one kind the first with a USABLE `dateModified`
 * wins; unparseable values are skipped while scanning rather than returned, so a
 * malformed date cannot hide a good one later in the graph or later in the same
 * node's date list. When no document node carries a usable date the answer is
 * null, and the caller falls through to the page's own visible date signals
 * rather than borrowing a sitewide one.
 */
function schemaDateModified(parsed: ParsedPage): string | null {
  if (!parsed.schema?.raw) return null;
  let pageLevel: string | null = null;
  // Flattened nodes include @graph children — a top-level-only read misses every
  // date on Yoast-style sites (same reason eeat/content-dates flattens).
  for (const node of flattenJsonLdNodes(parsed.schema.raw)) {
    const types = documentTypes(node);
    if (types.length === 0) continue;
    const value = schemaDateString(node["dateModified"], isUsableDate);
    if (!value) continue;
    if (types.some(isArticleType)) return value;
    pageLevel ??= value;
  }
  return pageLevel;
}

/**
 * The page's strongest own date signal: the document node's schema
 * `dateModified`, else the `dateModified`-equivalent markup the parser lifts from
 * `[itemprop=dateModified]` meta/`<time>` (`visibleDateModified`), else the
 * visible published date.
 *
 * Only parsed-page SCALARS are read — never `parsed.document` — so the rule sees
 * the same input on the legacy `site.pages` path and on the streaming path, where
 * every DOM has been dropped before site rules run.
 */
function resolvePageDate(parsed: ParsedPage): PageDate | null {
  const candidates: Array<{ value: string | null | undefined; source: DateSource }> = [
    { value: schemaDateModified(parsed), source: "schema" },
    { value: parsed.visibleDateModified, source: "meta" },
    { value: parsed.visibleDatePublished, source: "visible" },
  ];

  for (const candidate of candidates) {
    const value = candidate.value?.trim();
    const ms = parseDate(value);
    if (value && ms !== null) return { value, ms, source: candidate.source };
  }
  return null;
}

/** Sitemap `lastmod` by normalized URL; first entry wins on duplicate locs. */
function collectLastmods(discovered: SitemapData[]): Map<string, string> {
  const lastmods = new Map<string, string>();
  for (const sitemap of discovered) {
    for (const url of sitemap.urls) {
      if (!url.lastmod) continue;
      try {
        const key = normalizeUrl(url.loc);
        if (!lastmods.has(key)) lastmods.set(key, url.lastmod);
      } catch {
        // Skip malformed URLs
      }
    }
  }
  return lastmods;
}

interface Drift {
  url: string;
  lastmod: string;
  pageDate: string;
  source: DateSource;
  deltaDays: number;
}

function buildCheck(
  name: string,
  drifts: Drift[],
  message: string,
  comparedPages: number
): CheckResult {
  return {
    name,
    status: "warn",
    message,
    items: drifts.slice(0, MAX_ITEMS).map((drift) => ({
      id: drift.url,
      label: `lastmod ${drift.lastmod} vs dateModified ${drift.pageDate} (${drift.deltaDays} day(s))`,
      meta: {
        lastmod: drift.lastmod,
        pageDate: drift.pageDate,
        pageDateSource: drift.source,
        deltaDays: drift.deltaDays,
      },
    })),
    details: { total: drifts.length, comparedPages },
  };
}

export const sitemapLastmodDriftRule: Rule = {
  meta: {
    id: "crawl/sitemap-lastmod-drift",
    name: "Sitemap Lastmod Drift",
    description: "Checks that sitemap lastmod matches the page's own dateModified",
    solution:
      "A sitemap lastmod that disagrees with the page's own dateModified points at the sitemap generator, not the content. Lastmod OLDER than the page's dateModified tells crawlers not to bother with a page that has in fact changed - usually a stale cached sitemap, or a generator resolving `publishedAt ?? updatedAt` while the page renders `updatedAt ?? publishedAt` (a precedence inversion; both fields are present, so presence checks pass). Lastmod NEWER than the page's dateModified usually means lastmod is stamped at build/deploy time. Drive both values from the same content-modification timestamp.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
    optionsSchema,
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const sitemaps = ctx.site?.sitemaps;
    const pages = ctx.site?.pages;

    if (!sitemaps || sitemaps.discovered.length === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message: "No sitemap to compare",
            skipReason: "No sitemap found",
          },
        ],
      };
    }

    if (!pages || pages.length === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message: "No pages to compare",
            skipReason: "No pages crawled",
          },
        ],
      };
    }

    const lastmods = collectLastmods(sitemaps.discovered);
    const behind: Drift[] = [];
    const ahead: Drift[] = [];
    let comparedPages = 0;

    for (const page of pages) {
      let lastmod: string | undefined;
      try {
        lastmod = lastmods.get(normalizeUrl(page.url));
      } catch {
        continue; // Malformed page URL — nothing to match against.
      }
      if (!lastmod) continue;

      const lastmodMs = parseDate(lastmod);
      if (lastmodMs === null) continue; // Unparseable lastmod is crawl/sitemap-valid's job.

      // No page-side date at all is content/freshness territory, not drift.
      const pageDate = resolvePageDate(page.parsed);
      if (!pageDate) continue;

      comparedPages++;

      // Magnitude only — direction is read off the comparison below. Whole days,
      // so a same-day (and any sub-threshold) difference can never warn.
      const deltaDays = Math.round(Math.abs(pageDate.ms - lastmodMs) / MS_PER_DAY);
      const drift: Drift = {
        url: page.url,
        lastmod,
        pageDate: pageDate.value,
        source: pageDate.source,
        deltaDays,
      };

      if (pageDate.ms > lastmodMs && deltaDays > opts.behind_days) behind.push(drift);
      else if (lastmodMs > pageDate.ms && deltaDays > opts.ahead_days) ahead.push(drift);
    }

    if (comparedPages === 0) {
      return {
        checks: [
          {
            name: "sitemap-lastmod-drift",
            status: "skipped",
            message: "No sitemap URL carries both a lastmod and a page-side date signal",
            skipReason: "No comparable dates",
          },
        ],
      };
    }

    // Worst drift first, URL as the tie-break — deterministic regardless of the
    // order pages were crawled in.
    const byDelta = (a: Drift, b: Drift) => b.deltaDays - a.deltaDays || a.url.localeCompare(b.url);
    behind.sort(byDelta);
    ahead.sort(byDelta);

    const checks: CheckResult[] = [];

    // Reported separately from the ahead case: they point at different code.
    // Behind = stale sitemap or inverted date precedence, and it is the more
    // clearly wrong of the two (crawlers skip a page that really did change).
    if (behind.length > 0) {
      checks.push(
        buildCheck(
          "sitemap-lastmod-behind-page",
          behind,
          `${behind.length} page(s) have a sitemap lastmod older than the page's own dateModified by more than ${opts.behind_days} day(s)`,
          comparedPages
        )
      );
    }

    // Ahead = lastmod stamped at build/deploy time rather than on content change.
    if (ahead.length > 0) {
      checks.push(
        buildCheck(
          "sitemap-lastmod-ahead-of-page",
          ahead,
          `${ahead.length} page(s) have a sitemap lastmod newer than the page's own dateModified by more than ${opts.ahead_days} day(s)`,
          comparedPages
        )
      );
    }

    if (checks.length === 0) {
      checks.push({
        name: "sitemap-lastmod-drift",
        status: "pass",
        message: `${comparedPages} sitemap URL(s) carry a lastmod consistent with the page's own dateModified`,
        details: { comparedPages },
      });
    }

    return { checks };
  },
};
