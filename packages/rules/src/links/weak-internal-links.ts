import { logger } from "../logger";
import { frontDoorTest } from "../shared/front-door";
// links/weak-internal-links - Pages with minimal internal link support

import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { CRAWL_CAPPED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { matchesExcludePattern } from "@squirrelscan/utils";
import { getPathname, normalizeUrl } from "@squirrelscan/utils";

import { addSection, sectionMeta, withSection, type SectionCounts } from "./link-section-label";

const SKIP_CHECK: CheckResult = {
  name: "weak-internal-links",
  status: "skipped",
  message: "Insufficient pages for internal link analysis",
};

// Shared result builder — the legacy `site.pages` path and the streaming
// `siteQuery` path feed it the SAME `weakPages` list, so the emitted check is
// byte-identical regardless of how the incoming-link counts were sourced.
function buildWeakLinksCheck(
  weakPages: string[],
  sectionsFor?: (url: string) => SectionCounts | undefined
): CheckResult {
  if (weakPages.length > 0) {
    const pathList = weakPages
      .slice(0, 5)
      .map((url) => getPathname(url))
      .join("\n");

    const suffix =
      weakPages.length > 5 ? `\n+${weakPages.length - 5} more` : "";

    return {
      name: "weak-internal-links",
      status: "warn",
      message: `${weakPages.length} page(s) have only 1 internal link`,
      items: weakPages.map((url) => {
        // #2307: where the one link sits. Without section data the item stays bare.
        const sections = sectionsFor?.(url);
        return sections
          ? { id: url, label: withSection(url, sections), meta: sectionMeta(sections) }
          : { id: url };
      }),
      details: { total: weakPages.length },
      value: pathList + suffix,
    };
  }
  return {
    name: "weak-internal-links",
    status: "pass",
    message: "All pages have sufficient internal link support",
  };
}

// Given per-page (url, incomingCount) pairs in the crawl's stable order, flag
// pages that are neither the homepage nor excluded and have EXACTLY one incoming
// dofollow internal link. `url` is the page's stored (normalized) identity — the
// same value the legacy path reads as `page.url`.
function collectWeakPages(
  entries: Iterable<[string, number]>,
  excludePatterns: string[],
  baseUrl: string,
  entryUrls: readonly string[]
): string[] {
  const isFrontDoor = frontDoorTest(baseUrl, entryUrls);
  const weakPages: string[] = [];
  for (const [url, count] of entries) {
    // Skip the homepage, and the page the crawl started on (pub#796)
    const isHomepage = isFrontDoor(url);
    const isExcluded = matchesExcludePattern(url, excludePatterns);

    if (isHomepage || isExcluded) {
      continue;
    }

    // Flag pages with exactly 1 incoming link
    if (count === 1) {
      weakPages.push(url);
    }
  }
  return weakPages;
}

export const weakInternalLinksRule: Rule = {
  meta: {
    id: "links/weak-internal-links",
    name: "Weak Internal Links",
    description:
      "Detects pages with only 1 dofollow internal link pointing to them",
    solution:
      "Pages with only a single internal link have weak internal linking support and may struggle to rank. Search engines use internal links to understand page importance and distribute link equity. Add contextual links from related content, include in navigation or sidebar, or link from category/hub pages to strengthen internal link profiles.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 3,
    optionsSchema: z.object({
      excludePatterns: z
        .array(z.string())
        .default([])
        .describe("URL patterns to exclude from weak link detection"),
    }),
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const options = ctx.options;
    const excludePatterns = options.excludePatterns as string[];

    // A capped crawl cannot prove that a page has exactly one inbound link: an
    // uncrawled page may contain another link to it.
    const limits = ctx.site?.crawlLimits;
    if (limits && limits.pagesCrawled >= limits.maxPages) {
      checks.push({
        name: "weak-internal-links",
        status: "skipped",
        message: `Crawl stopped at its ${limits.maxPages}-page cap, so an inbound link may sit on a page not crawled`,
        skipReason: CRAWL_CAPPED_SKIP_REASON,
      });
      return { checks };
    }

    // Streaming path (#1022): read pre-materialized incoming-link counts instead
    // of holding every parsed page resident. `incomingLinkCounts()` is keyed by
    // each crawled page's stored URL (crawl order) with its dofollow internal
    // incoming count.
    if (ctx.siteQuery) {
      const counts = ctx.siteQuery.incomingLinkCounts();
      if (counts.size < 2) {
        checks.push(SKIP_CHECK);
        return { checks };
      }
      const weakPages = collectWeakPages(
        counts,
        excludePatterns,
        ctx.site?.baseUrl || "",
        ctx.site?.entryUrls ?? []
      );
      const sections = ctx.siteQuery.inboundSectionCounts?.();
      checks.push(
        buildWeakLinksCheck(weakPages, sections ? (url) => sections.get(url) : undefined)
      );
      return { checks };
    }

    // Legacy path — rebuild incoming counts from every page's parsed links.
    const pages = ctx.site?.pages;

    if (!pages || pages.length < 2) {
      checks.push(SKIP_CHECK);
      return { checks };
    }

    // Build map of incoming dofollow link counts per URL
    const incomingLinkCount = new Map<string, number>();
    // #2307: the same counted links, per link section, under the same normalized key.
    const sections = new Map<string, SectionCounts>();
    const normalizedCache = new Map<string, string>();

    // Phase 1: Initialize all pages with 0 incoming links and cache normalized URLs
    for (const page of pages) {
      const normalized = normalizeUrl(page.url);
      normalizedCache.set(page.url, normalized);
      incomingLinkCount.set(normalized, 0);
    }

    // Phase 2: Count incoming dofollow links
    let invalidUrlCount = 0;
    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (link.isInternal && link.url && !link.isNofollow) {
          try {
            const linkUrl = new URL(link.url, page.url);
            const normalizedTarget = normalizeUrl(linkUrl.href);

            // Increment count if this page exists in our crawl
            const current = incomingLinkCount.get(normalizedTarget);
            if (current !== undefined) {
              incomingLinkCount.set(normalizedTarget, current + 1);
              addSection(sections, normalizedTarget, link.section);
            }
          } catch {
            invalidUrlCount++;
            logger.debug(
              `[weak-internal-links] Invalid internal link URL: "${link.url}" on page ${getPathname(page.url)}`
            );
          }
        }
      }
    }

    if (invalidUrlCount > 0) {
      logger.debug(
        `[weak-internal-links] Found ${invalidUrlCount} invalid internal link URL(s) during link counting`
      );
    }

    // Phase 3: Find pages with exactly 1 incoming link
    const weakPages = collectWeakPages(
      pages.map(
        (page) =>
          [page.url, incomingLinkCount.get(normalizedCache.get(page.url)!) ?? 0] as [
            string,
            number,
          ]
      ),
      excludePatterns,
      ctx.site?.baseUrl || "",
      ctx.site?.entryUrls ?? []
    );

    // Report results
    checks.push(
      buildWeakLinksCheck(weakPages, (url) => {
        const key = normalizedCache.get(url);
        return key === undefined ? undefined : sections.get(key);
      })
    );

    return { checks };
  },
};
