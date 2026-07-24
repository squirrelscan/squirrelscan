import { logger } from "../logger";
// links/orphan-pages - Pages with no internal links

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { matchesExcludePattern } from "@squirrelscan/utils";
import { getPathname, normalizeUrl } from "@squirrelscan/utils";

const SKIP_CHECK: CheckResult = {
  name: "orphan-pages",
  status: "skipped",
  message: "Insufficient pages for orphan analysis",
};

// Shared result builder — both the legacy `site.pages` path and the streaming
// `siteQuery` path feed it the SAME `orphans` list, so the emitted check is
// byte-identical regardless of how the incoming-link counts were sourced.
function buildOrphanCheck(orphans: string[], minLinks: number): CheckResult {
  if (orphans.length > 0) {
    const pathList = orphans
      .slice(0, 5)
      .map((url) => getPathname(url))
      .join("\n");

    const suffix = orphans.length > 5 ? `\n+${orphans.length - 5} more` : "";

    return {
      name: "orphan-pages",
      status: "warn",
      message: `${orphans.length} orphan page(s) with <${minLinks} incoming links`,
      items: orphans.map((url) => ({ id: url })),
      details: { total: orphans.length },
      value: pathList + suffix,
    };
  }
  return {
    name: "orphan-pages",
    status: "pass",
    message: "All pages have sufficient internal links pointing to them",
  };
}

// Given per-page (url, incomingCount) pairs in the crawl's stable order, flag the
// pages that are neither the homepage nor excluded and sit below the threshold.
// The `url` is the page's stored (normalized) identity — the same value the
// legacy path reads as `page.url` — so homepage/exclude/output all match.
function collectOrphans(
  entries: Iterable<[string, number]>,
  minLinks: number,
  excludePatterns: string[],
  baseUrl: string
): string[] {
  const normalizedBase = normalizeUrl(baseUrl);
  const orphans: string[] = [];
  for (const [url, count] of entries) {
    const normalizedUrl = normalizeUrl(url);

    // Skip homepage
    const isHomepage = normalizedUrl === normalizedBase || getPathname(url) === "/";
    const isExcluded = matchesExcludePattern(url, excludePatterns);

    if (isHomepage || isExcluded) {
      continue;
    }

    if (count < minLinks) {
      orphans.push(url);
    }
  }
  return orphans;
}

export const orphanPagesRule: Rule = {
  meta: {
    id: "links/orphan-pages",
    name: "Orphan Pages",
    description: "Detects pages with no internal links pointing to them",
    solution:
      "Orphan pages have no internal links and are hard for search engines to discover. They may not get indexed or rank well. Add internal links from relevant pages. Include in navigation or sidebar. Add to sitemap. Create contextual links from related content. If intentionally orphaned (e.g., landing pages), ensure they're accessible via sitemap.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 5,
    optionsSchema: z.object({
      minInboundLinks: z
        .number()
        .int()
        .min(0)
        .default(2)
        .describe(
          "Minimum inbound links required (pages below this are flagged)"
        ),
      excludePatterns: z
        .array(z.string())
        .default([])
        .describe("URL patterns to exclude from orphan detection"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const options = ctx.options;
    const minLinks = options.minInboundLinks as number;
    const excludePatterns = options.excludePatterns as string[];

    // Streaming path (#1022): read pre-materialized incoming-link counts instead
    // of holding every parsed page resident. `incomingLinkCounts()` is keyed by
    // each crawled page's stored URL (crawl order) with its dofollow internal
    // incoming count, so the count/homepage/exclude logic mirrors the legacy
    // path below exactly.
    if (ctx.siteQuery) {
      const counts = ctx.siteQuery.incomingLinkCounts();
      if (counts.size < 2) {
        checks.push(SKIP_CHECK);
        return { checks };
      }
      const orphans = collectOrphans(
        counts,
        minLinks,
        excludePatterns,
        ctx.site?.baseUrl || ""
      );
      checks.push(buildOrphanCheck(orphans, minLinks));
      return { checks };
    }

    // Legacy path — rebuild incoming counts from every page's parsed links.
    const pages = ctx.site?.pages;

    if (!pages || pages.length < 2) {
      checks.push(SKIP_CHECK);
      return { checks };
    }

    // Build map of incoming link counts per URL
    const incomingLinkCount = new Map<string, number>();
    const normalizedCache = new Map<string, string>();

    // Phase 1: Initialize all pages with 0 incoming links and cache normalized URLs
    for (const page of pages) {
      const normalized = normalizeUrl(page.url);
      normalizedCache.set(page.url, normalized);
      incomingLinkCount.set(normalized, 0);
    }

    // Phase 2: Count incoming links
    let invalidUrlCount = 0;
    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (link.isInternal && link.url && !link.isNofollow) {
          // Normalize URL
          try {
            const linkUrl = new URL(link.url, page.url);
            const normalizedTarget = normalizeUrl(linkUrl.href);

            // Increment count if this page exists in our crawl (single Map.get)
            const current = incomingLinkCount.get(normalizedTarget);
            if (current !== undefined) {
              incomingLinkCount.set(normalizedTarget, current + 1);
            }
          } catch {
            // Invalid URL - count and log for debugging
            invalidUrlCount++;
            logger.debug(
              `[orphan-pages] Invalid internal link URL: "${link.url}" on page ${getPathname(page.url)}`
            );
          }
        }
      }
    }

    // Log invalid URL summary if any found
    if (invalidUrlCount > 0) {
      logger.debug(
        `[orphan-pages] Found ${invalidUrlCount} invalid internal link URL(s) during link counting`
      );
    }

    // Phase 3: Find orphan pages (use cached normalized URLs)
    const orphans = collectOrphans(
      pages.map(
        (page) =>
          [page.url, incomingLinkCount.get(normalizedCache.get(page.url)!) ?? 0] as [
            string,
            number,
          ]
      ),
      minLinks,
      excludePatterns,
      ctx.site?.baseUrl || ""
    );

    // Report results
    checks.push(buildOrphanCheck(orphans, minLinks));

    return { checks };
  },
};
