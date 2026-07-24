// crawl/robots-meta-conflict - Robots meta vs robots.txt conflict detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

// Robots.txt `*`-agent disallow test for one path — identical in both paths.
function isPathBlockedByStar(path: string, robotsTxt: RobotsTxtData): boolean {
  return robotsTxt.rules.some((rule) => {
    if (rule.userAgent !== "*") return false;
    return rule.rules.some((r) => {
      if (r.type !== "disallow") return false;
      if (r.path === "/") return true;
      return path.startsWith(r.path);
    });
  });
}

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

// Streaming path (#1022): meta-only noindex is the pre-extracted `metaNoindex`
// scalar; the robots.txt `*`-disallow test stays a run-time computation over the
// (site-level) robotsTxt. `conflicts` is never populated (mirrors the legacy path).
async function runViaSiteQuery(
  siteQuery: SiteQuery,
  robotsTxt: RobotsTxtData
): Promise<RuleResult> {
  const conflicts: string[] = [];
  const redundantNoindex: string[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const path = new URL(row.normalizedUrl).pathname;
    if (isPathBlockedByStar(path, robotsTxt) && row.metaNoindex) {
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
      "Robots.txt and robots meta tags should work together, not conflict. If robots.txt blocks a URL, search engines won't see the meta robots tag at all. Common conflicts: blocking a page in robots.txt while trying to noindex it (unnecessary), or allowing in robots.txt but noindexing (works but confusing). For noindex, let the page be crawled so the directive is seen. For blocked pages, robots.txt alone is sufficient.",
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
      const url = new URL(page.url);
      const path = url.pathname;
      const robotsMeta = page.parsed.meta.robots;

      // Check if this path is disallowed by robots.txt
      const isBlocked = isPathBlockedByStar(path, robotsTxt);

      // Check if page has noindex meta
      const hasNoindex = robotsMeta
        ?.toLowerCase()
        .split(",")
        .map((d) => d.trim())
        .includes("noindex");

      if (isBlocked && hasNoindex) {
        // Blocked in robots.txt AND has noindex - redundant
        redundantNoindex.push(page.url);
      }
    }

    return { checks: buildChecks(conflicts, redundantNoindex) };
  },
};
