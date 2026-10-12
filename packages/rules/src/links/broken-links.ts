// links/broken-links - Broken link detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { LINK_TARGETS_NOT_FETCHED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { normalizeUrl } from "@squirrelscan/utils";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

export const brokenLinksRule: Rule = {
  meta: {
    id: "links/broken-links",
    name: "Broken Links",
    description: "Detects links returning 404 or 5xx errors",
    solution:
      "Broken links hurt user experience and waste crawl budget. Regularly audit links using tools or crawlers. Fix or remove broken links. Set up 301 redirects for moved content. For external links, consider using nofollow and regularly verifying they still work. Implement custom 404 pages that help users find content.",
    category: "links",
    scope: "site",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages) {
      checks.push({
        name: "broken-links",
        status: "skipped",
        message: "Site data not available for broken link analysis",
      });
      return { checks };
    }

    // Collect all link targets and their sources
    const linkTargets = new Map<string, string[]>();

    for (const page of pages) {
      for (const link of page.parsed.links) {
        if (link.isInternal && link.url) {
          const sources = linkTargets.get(link.url) || [];
          sources.push(page.url);
          linkTargets.set(link.url, sources);
        }
      }
    }

    // Build map of crawled URLs with their status codes
    // Normalization: strips hash, trailing slash, lowercases scheme/host (not path)
    const crawledPages = new Map<string, number>();
    for (const page of pages) {
      crawledPages.set(normalizeUrl(page.url), page.statusCode);
    }

    const brokenLinks: {
      url: string;
      sources: string[];
      statusCode: number;
    }[] = [];
    const rateLimitedLinks: {
      url: string;
      sources: string[];
      statusCode: number;
    }[] = [];

    // Distinct targets the crawl never fetched: their status is unknown.
    const unfetchedTargets = new Set<string>();
    const allTargets = new Set<string>();

    for (const [target, sources] of linkTargets) {
      // Normalize target URL to match crawler's normalization
      const normalizedTarget = normalizeUrl(target);
      allTargets.add(normalizedTarget);
      const statusCode = crawledPages.get(normalizedTarget);
      if (statusCode === undefined) {
        unfetchedTargets.add(normalizedTarget);
        continue;
      }

      // #1829: a 429/430 means the host throttled the crawl, not that the page
      // is missing. The adapter already keeps rate-limited pages out of the
      // corpus, so this is the second line of defence for a status that reached
      // the rules another way (a stored page from an older crawl, a cloud
      // render result). Must precede the >= 400 test.
      if (isRateLimitStatus(statusCode)) {
        rateLimitedLinks.push({ url: target, sources, statusCode });
        continue;
      }

      // Only broken if we crawled it AND got error status (4xx/5xx)
      if (statusCode >= 400) {
        brokenLinks.push({ url: target, sources, statusCode });
      }
    }

    // repo#2729: a crawl that did not follow links (Quick, sitemap scope) never
    // fetched the targets outside the seed and the sitemaps. "No broken links"
    // would then be a pass on links nobody requested, and it resolved open
    // broken-link issues on every such run. Say they were not checked instead.
    const notFollowed = ctx.site?.linkDiscoveryOff === true && unfetchedTargets.size > 0;

    if (brokenLinks.length > 0) {
      checks.push({
        name: "broken-links",
        status: "fail",
        message: `${brokenLinks.length} broken internal link(s) (4xx/5xx)`,
        items: brokenLinks.map((b) => ({
          id: b.url,
          label: `${b.url} (${b.statusCode})`,
          sourcePages: b.sources,
          meta: { statusCode: b.statusCode, linkedFrom: b.sources.length },
        })),
      });
    } else if (!notFollowed) {
      checks.push({
        name: "broken-links",
        status: "pass",
        message: "No broken internal links detected",
        // What the pass covers (repo#2729). Its presence also tells a reader of
        // the result that this engine reports unfetched targets as skipped, so
        // a pass here was not vacuous.
        details: { linkTargets: allTargets.size, unfetchedTargets: unfetchedTargets.size },
      });
    }

    if (notFollowed) {
      checks.push({
        name: "broken-links",
        status: "skipped",
        message: `${unfetchedTargets.size} of ${allTargets.size} internal link target(s) were not fetched because this audit did not follow links, so they were not checked for broken links`,
        skipReason: LINK_TARGETS_NOT_FETCHED_SKIP_REASON,
        value: unfetchedTargets.size,
        details: { linkTargets: allTargets.size, unfetchedTargets: unfetchedTargets.size },
      });
    }

    if (rateLimitedLinks.length > 0) {
      checks.push({
        name: "rate-limited-links",
        status: "info",
        message: `${rateLimitedLinks.length} internal link(s) rate-limited - status unverifiable`,
        items: rateLimitedLinks.map((b) => ({
          id: b.url,
          label: `${b.url} (${b.statusCode})`,
          sourcePages: b.sources,
          meta: { statusCode: b.statusCode, rateLimited: true },
        })),
      });
    }

    return { checks };
  },
};
