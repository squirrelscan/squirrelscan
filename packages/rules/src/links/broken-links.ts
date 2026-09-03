// links/broken-links - Broken link detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

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

    for (const [target, sources] of linkTargets) {
      // Normalize target URL to match crawler's normalization
      const normalizedTarget = normalizeUrl(target);
      const statusCode = crawledPages.get(normalizedTarget);
      if (statusCode === undefined) continue;

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
