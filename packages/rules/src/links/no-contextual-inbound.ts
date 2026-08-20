// links/no-contextual-inbound - Pages whose only inbound links are sitewide chrome
//
// The blind spot this closes (#109). `links/orphan-pages` and
// `links/weak-internal-links` both count RAW inbound links: a link from the
// footer that every page on the site carries scores exactly the same as a link
// from the middle of a related article. So a page reachable only through the
// header nav, the footer, or a sidebar widget shows a healthy inbound count and
// passes both rules while receiving no editorial support at all.
//
// This rule counts only CONTEXTUAL inbound links — those whose anchor did NOT sit
// in a `nav`/`header`/`footer`/`aside` landmark (`LinkData.isChrome`, set by the
// parser) — and warns when that count is zero.
//
// FALSE-POSITIVE TRAPS, and why each is handled the way it is:
//
//   * OVERLAP WITH orphan-pages. A page with zero contextual AND zero raw inbound
//     links is already an orphan; reporting it twice is noise. So a page is
//     flagged only when its RAW count is at or above the orphan threshold
//     (`minInboundLinks`, the same default 2) — i.e. exactly when orphan-pages
//     stays silent. Keep the two thresholds in sync when tuning.
//   * THE HOMEPAGE. Reached from every page's header/footer by design; it has no
//     contextual-equity problem. Skipped, exactly as orphan-pages skips it.
//   * A CHROME-ONLY CRAWL. Not special-cased: if a whole site links only through
//     chrome, every one of its pages genuinely lacks contextual support. The
//     `value` sample is capped so the finding stays readable; `details.total`
//     and `items` carry the full picture, exactly as orphan-pages does.
//   * OLD CRAWLS. `isChrome` is optional on `LinkData` (crawls stored before
//     #109 omit it). `undefined` counts as contextual on BOTH paths, so an old DB
//     produces contextual == raw and this rule simply passes — never a site-wide
//     false alarm.
//
// Both paths (legacy `site.pages`, streaming `siteQuery`) feed the SAME
// `collectChromeOnlyPages` helper the same `(url, {all, contextual})` pairs, so
// the emitted check is byte-identical regardless of how the counts were sourced
// (`site-query-link-rules-golden.test.ts` is the gate).

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { LinkData } from "@squirrelscan/core-contracts";

import { matchesExcludePattern } from "@squirrelscan/utils";
import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import { logger } from "../logger";

const SKIP_CHECK: CheckResult = {
  name: "no-contextual-inbound",
  status: "skipped",
  message: "Insufficient pages for contextual inbound link analysis",
};

// Sampled paths shown in `value`; `details.total` always carries the real count.
const MAX_SAMPLE = 5;

/** One page's raw and contextual (non-chrome) inbound dofollow-internal counts. */
interface InboundCounts {
  all: number;
  contextual: number;
}

// Shared result builder — both paths feed it the SAME `pages` list.
function buildCheck(pages: string[]): CheckResult {
  if (pages.length > 0) {
    const pathList = pages
      .slice(0, MAX_SAMPLE)
      .map((url) => getPathname(url))
      .join("\n");

    const suffix =
      pages.length > MAX_SAMPLE ? `\n+${pages.length - MAX_SAMPLE} more` : "";

    return {
      name: "no-contextual-inbound",
      status: "warn",
      message: `${pages.length} page(s) are linked only from sitewide chrome`,
      items: pages.map((url) => ({ id: url })),
      details: { total: pages.length },
      value: pathList + suffix,
    };
  }
  return {
    name: "no-contextual-inbound",
    status: "pass",
    message: "All pages have at least one contextual inbound link",
  };
}

// Given per-page counts in the crawl's stable order, flag the pages that are
// neither the homepage nor excluded, have NO contextual inbound link, and carry
// enough raw inbound links that `links/orphan-pages` stays silent about them.
function collectChromeOnlyPages(
  entries: Iterable<[string, InboundCounts]>,
  minInboundLinks: number,
  excludePatterns: string[],
  baseUrl: string
): string[] {
  const normalizedBase = normalizeUrl(baseUrl);
  const flagged: string[] = [];
  for (const [url, counts] of entries) {
    const normalizedUrl = normalizeUrl(url);

    // Skip homepage — same test orphan-pages uses.
    const isHomepage = normalizedUrl === normalizedBase || getPathname(url) === "/";
    const isExcluded = matchesExcludePattern(url, excludePatterns);

    if (isHomepage || isExcluded) {
      continue;
    }

    // Only the orphan rules' blind spot: well-linked on paper, chrome-only in fact.
    if (counts.contextual === 0 && counts.all >= minInboundLinks) {
      flagged.push(url);
    }
  }
  return flagged;
}

/** A link that participates in the internal link graph (mirrors the orphan rules). */
function isGraphLink(link: LinkData): boolean {
  return Boolean(link.isInternal && link.url && !link.isNofollow);
}

export const noContextualInboundRule: Rule = {
  meta: {
    id: "links/no-contextual-inbound",
    name: "No Contextual Inbound Links",
    description:
      "Detects pages whose only internal inbound links come from sitewide chrome (nav, header, footer, sidebar)",
    solution:
      "These pages look well-linked but receive no editorial support: every link pointing at them is repeated on every page of the site, so it carries no signal about what the page is about or how important it is. Add links from the body copy of related articles, hub pages, or category descriptions using descriptive anchor text. Sitewide navigation links help discovery, but contextual links are what pass topical relevance and internal link equity.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 4,
    optionsSchema: z.object({
      minInboundLinks: z
        .number()
        .int()
        .min(0)
        .default(2)
        .describe(
          "Raw inbound-link threshold from links/orphan-pages; only pages at or above it are considered here (below it they are already reported as orphans)"
        ),
      excludePatterns: z
        .array(z.string())
        .default([])
        .describe("URL patterns to exclude from contextual inbound link detection"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const options = ctx.options;
    const minInboundLinks = options.minInboundLinks as number;
    const excludePatterns = options.excludePatterns as string[];

    // Streaming path — read the pre-materialized counts. Both maps are built by
    // one pass over the same links with the same key/order, so zipping them by
    // key is safe.
    if (ctx.siteQuery) {
      const all = ctx.siteQuery.incomingLinkCounts();
      if (all.size < 2) {
        checks.push(SKIP_CHECK);
        return { checks };
      }
      const contextual = ctx.siteQuery.contextualIncomingLinkCounts();
      const entries: Array<[string, InboundCounts]> = [];
      for (const [url, count] of all) {
        entries.push([url, { all: count, contextual: contextual.get(url) ?? 0 }]);
      }
      checks.push(
        buildCheck(
          collectChromeOnlyPages(
            entries,
            minInboundLinks,
            excludePatterns,
            ctx.site?.baseUrl || ""
          )
        )
      );
      return { checks };
    }

    // Legacy path — rebuild both counts from every page's parsed links.
    const pages = ctx.site?.pages;

    if (!pages || pages.length < 2) {
      checks.push(SKIP_CHECK);
      return { checks };
    }

    const counts = new Map<string, InboundCounts>();
    const normalizedCache = new Map<string, string>();

    // Phase 1: initialize every crawled page at zero and cache normalized URLs.
    for (const page of pages) {
      const normalized = normalizeUrl(page.url);
      normalizedCache.set(page.url, normalized);
      counts.set(normalized, { all: 0, contextual: 0 });
    }

    // Phase 2: count dofollow internal links whose target is a crawled page,
    // splitting chrome from contextual.
    let invalidUrlCount = 0;
    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (!isGraphLink(link)) continue;
        try {
          const linkUrl = new URL(link.url, page.url);
          const current = counts.get(normalizeUrl(linkUrl.href));
          if (current !== undefined) {
            current.all += 1;
            if (!link.isChrome) current.contextual += 1;
          }
        } catch {
          invalidUrlCount++;
          logger.debug(
            `[no-contextual-inbound] Invalid internal link URL: "${link.url}" on page ${getPathname(page.url)}`
          );
        }
      }
    }

    if (invalidUrlCount > 0) {
      logger.debug(
        `[no-contextual-inbound] Found ${invalidUrlCount} invalid internal link URL(s) during link counting`
      );
    }

    // Phase 3: flag the chrome-only pages (use cached normalized URLs).
    const flagged = collectChromeOnlyPages(
      pages.map(
        (page) =>
          [
            page.url,
            counts.get(normalizedCache.get(page.url)!) ?? { all: 0, contextual: 0 },
          ] as [string, InboundCounts]
      ),
      minInboundLinks,
      excludePatterns,
      ctx.site?.baseUrl || ""
    );

    checks.push(buildCheck(flagged));

    return { checks };
  },
};
