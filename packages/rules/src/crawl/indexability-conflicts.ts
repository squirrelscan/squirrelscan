import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

import { isPageIndexable, isRobotsTxtDisallowed } from "@squirrelscan/utils";
import { getPathname } from "@squirrelscan/utils";

const SKIP_CHECK: CheckResult = {
  name: "conflicts",
  status: "skipped",
  message: "Insufficient data (no robots.txt or pages)",
};

// Shared output builder, identical CheckResult[] given the same blocked list.
// robots.txt Allow plus noindex is the supported way to deindex a page (the
// crawler has to fetch it to read the directive), so it is not reported. Disallow
// plus noindex belongs to crawl/robots-meta-conflict.
function buildChecks(blockedWithoutNoindex: string[]): CheckResult[] {
  if (blockedWithoutNoindex.length === 0) {
    return [
      {
        name: "conflicts",
        status: "pass",
        message: "No indexability conflicts detected",
      },
    ];
  }

  return [
    {
      name: "robots-block-without-noindex",
      status: "info",
      message: `${blockedWithoutNoindex.length} page(s) blocked by robots.txt without noindex`,
      value:
        blockedWithoutNoindex.slice(0, 3).map(getPathname).join("\n") +
        (blockedWithoutNoindex.length > 3 ? `\n+${blockedWithoutNoindex.length - 3} more` : ""),
      pages: blockedWithoutNoindex,
    },
  ];
}

// Streaming path (#1022): the meta/header indexability verdict is the pre-extracted
// `indexableReasons` (2-arg isPageIndexable == meta+header only), so
// `isIndexable === reasons.length === 0`. robots.txt stays a run-time test.
async function runViaSiteQuery(
  siteQuery: SiteQuery,
  robotsTxt: RobotsTxtData
): Promise<RuleResult> {
  const blocked: string[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const metaIndexable = row.indexableReasons.length === 0;
    if (metaIndexable && isRobotsTxtDisallowed(row.normalizedUrl, robotsTxt)) {
      blocked.push(row.normalizedUrl);
    }
  }
  return { checks: buildChecks(blocked) };
}

export const indexabilityConflicts: Rule = {
  meta: {
    id: "crawl/indexability-conflicts",
    name: "Indexability Conflicts",
    description:
      "Detects pages blocked by robots.txt that carry no noindex",
    solution:
      "Allowing a page in robots.txt and marking it noindex is the correct way to keep it out of search results, and is not reported. A page blocked in robots.txt without noindex is never fetched, so the URL can still be listed from links elsewhere. To remove it from results, allow the crawl and add noindex; to only save crawl budget, the Disallow alone is fine.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const robotsTxt = ctx.site?.robotsTxt;

    if (ctx.siteQuery) {
      if (!robotsTxt?.exists || ctx.siteQuery.pageCount() === 0) {
        return { checks: [SKIP_CHECK] };
      }
      return runViaSiteQuery(ctx.siteQuery, robotsTxt);
    }

    const pages = ctx.site?.pages;

    if (!robotsTxt?.exists || !pages || pages.length === 0) {
      return { checks: [SKIP_CHECK] };
    }

    const blocked: string[] = [];

    for (const page of pages) {
      const metaCheck = isPageIndexable(page.parsed, page.headers);
      if (metaCheck.isIndexable && isRobotsTxtDisallowed(page.url, robotsTxt)) {
        blocked.push(page.url);
      }
    }

    return { checks: buildChecks(blocked) };
  },
};
