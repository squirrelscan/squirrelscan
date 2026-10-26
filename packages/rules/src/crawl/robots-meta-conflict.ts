// crawl/robots-meta-conflict - Robots meta vs robots.txt conflict detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

import { isPageIndexable, isRobotsTxtDisallowed } from "@squirrelscan/utils";

/** noindex from the meta tag or the header; an unparseable page is not noindex. */
function hasNoindex(reasons: readonly string[]): boolean {
  return reasons.includes("meta:noindex") || reasons.includes("header:noindex");
}

// pub#556: "blocked by robots.txt" is the shared isRobotsTxtDisallowed, the
// same decision crawl/indexability-conflicts makes (Allow, Disallow, longest
// match, wildcards), and noindex is the meta tag or the X-Robots-Tag header.

// Shared output builder — identical CheckResult[] given the same collected lists.
// `conflicts` is vestigial (never populated in either path — the "robots-conflict"
// warn branch is dead code) but is kept in the signature to preserve the exact
// legacy output structure; both callers pass an empty array.
function buildChecks(conflicts: string[], redundantNoindex: string[]): CheckResult[] {
  const checks: CheckResult[] = [];
  if (redundantNoindex.length > 0) {
    checks.push({
      name: "redundant-noindex",
      status: "info",
      message: `${redundantNoindex.length} page(s) blocked in robots.txt also have noindex`,
      value: "noindex won't be seen if page is blocked from crawling",
      pages: redundantNoindex,
    });
  }

  if (conflicts.length > 0) {
    checks.push({
      name: "robots-conflict",
      status: "warn",
      message: `${conflicts.length} robots directive conflict(s) found`,
      items: conflicts.map((c) => ({ id: c })),
    });
  } else {
    checks.push({
      name: "robots-conflict",
      status: "pass",
      message: "No robots meta/robots.txt conflicts detected",
    });
  }
  return checks;
}

// Streaming path (#1022): noindex is the pre-extracted `indexableReasons`
// (meta tag and X-Robots-Tag header); the robots.txt test stays a run-time
// computation over the site-level robotsTxt. `conflicts` is never populated
// (mirrors the legacy path).
async function runViaSiteQuery(
  siteQuery: SiteQuery,
  robotsTxt: RobotsTxtData
): Promise<RuleResult> {
  const conflicts: string[] = [];
  const redundantNoindex: string[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    if (hasNoindex(row.indexableReasons) && isRobotsTxtDisallowed(row.normalizedUrl, robotsTxt)) {
      redundantNoindex.push(row.normalizedUrl);
    }
  }
  return { checks: buildChecks(conflicts, redundantNoindex) };
}

export const robotsMetaConflictRule: Rule = {
  meta: {
    id: "crawl/robots-meta-conflict",
    name: "Robots Meta Conflict",
    description: "Detects conflicts between robots meta tags and robots.txt",
    solution:
      "If robots.txt blocks a URL, search engines never fetch it, so they never see its noindex, from a meta tag or an X-Robots-Tag header. To keep a page out of search results, allow it in robots.txt and add noindex; that is the supported way. To only save crawl budget, the Disallow alone is enough and the noindex does nothing.",
    category: "crawl",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const robotsTxt = ctx.site?.robotsTxt;

    if (ctx.siteQuery) {
      if (!robotsTxt?.exists || ctx.siteQuery.pageCount() === 0) {
        return {
          checks: [
            {
              name: "robots-meta-conflict",
              status: "skipped",
              message: "Insufficient data to check for conflicts",
            },
          ],
        };
      }
      return runViaSiteQuery(ctx.siteQuery, robotsTxt);
    }

    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!robotsTxt?.exists || !pages || pages.length === 0) {
      checks.push({
        name: "robots-meta-conflict",
        status: "skipped",
        message: "Insufficient data to check for conflicts",
      });
      return { checks };
    }

    const conflicts: string[] = [];
    const redundantNoindex: string[] = [];

    for (const page of pages) {
      const isBlocked = isRobotsTxtDisallowed(page.url, robotsTxt);
      // noindex from the meta tag or the X-Robots-Tag header (pub#556).
      const noindex = hasNoindex(isPageIndexable(page.parsed, page.headers).reasons);

      if (isBlocked && noindex) {
        // Blocked in robots.txt AND has noindex - redundant
        redundantNoindex.push(page.url);
      }
    }

    return { checks: buildChecks(conflicts, redundantNoindex) };
  },
};
