// links/broken-links - Broken link detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { normalizeUrl } from "@squirrelscan/utils";

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

    for (const [target, sources] of linkTargets) {
      // Normalize target URL to match crawler's normalization
      const normalizedTarget = normalizeUrl(target);
      const statusCode = crawledPages.get(normalizedTarget);

      // Only broken if we crawled it AND got error status (4xx/5xx)
      if (statusCode !== undefined && statusCode >= 400) {
        brokenLinks.push({ url: target, sources, statusCode });
      }
    }

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
    } else {
      checks.push({
        name: "broken-links",
        status: "pass",
        message: "No broken internal links detected",
      });
    }

    return { checks };
  },
};
