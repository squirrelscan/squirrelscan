import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

import { isPageIndexable, isRobotsTxtDisallowed } from "@squirrelscan/utils";
import { getPathname } from "@squirrelscan/utils";

const SKIP_CHECK: CheckResult = {
  name: "conflicts",
  status: "skipped",
  message: "Insufficient data (no robots.txt or pages)",
};

// Shared output builder — identical CheckResult[] given the same type1/type2 lists.
function buildChecks(type1: string[], type2: string[]): CheckResult[] {
  const checks: CheckResult[] = [];

  if (type1.length > 0) {
    checks.push({
      name: "robots-allow-but-noindex",
      status: "warn",
      message: `${type1.length} page(s) allowed in robots.txt but have noindex`,
      value:
        type1.slice(0, 3).map(getPathname).join("\n") +
        (type1.length > 3 ? `\n+${type1.length - 3} more` : ""),
    });
  }

  if (type2.length > 0) {
    checks.push({
      name: "robots-block-without-noindex",
      status: "info",
      message: `${type2.length} page(s) blocked by robots.txt (noindex meta not needed)`,
      value:
        type2.slice(0, 3).map(getPathname).join("\n") +
        (type2.length > 3 ? `\n+${type2.length - 3} more` : ""),
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "conflicts",
      status: "pass",
      message: "No indexability conflicts detected",
    });
  }

  return checks;
}

// Streaming path (#1022): the meta/header indexability verdict is the pre-extracted
// `indexableReasons` (2-arg isPageIndexable == meta+header only), so
// `isIndexable === reasons.length === 0`. robots.txt stays a run-time test.
async function runViaSiteQuery(
  siteQuery: SiteQuery,
  robotsTxt: RobotsTxtData
): Promise<RuleResult> {
  const type1: string[] = [];
  const type2: string[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const robotsBlocked = isRobotsTxtDisallowed(row.normalizedUrl, robotsTxt);
    const metaIndexable = row.indexableReasons.length === 0;
    if (!robotsBlocked && !metaIndexable) {
      type1.push(row.normalizedUrl);
    } else if (robotsBlocked && metaIndexable) {
      type2.push(row.normalizedUrl);
    }
  }
  return { checks: buildChecks(type1, type2) };
}

export const indexabilityConflicts: Rule = {
  meta: {
    id: "crawl/indexability-conflicts",
    name: "Indexability Conflicts",
    description:
      "Detects conflicting signals between robots.txt and meta/headers",
    solution:
      "Conflicting signals confuse search engines and indicate configuration errors. Type 1 conflict: robots.txt allows BUT meta/header has noindex (works but confusing - choose one method). Type 2 conflict: robots.txt disallows BUT page crawlable (search engines can't crawl to see noindex anyway - remove unnecessary noindex or allow in robots.txt).",
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

    const type1: string[] = []; // robots.txt allows, but meta/header noindex
    const type2: string[] = []; // robots.txt blocks, no noindex needed

    for (const page of pages) {
      const robotsBlocked = isRobotsTxtDisallowed(page.url, robotsTxt);
      const metaCheck = isPageIndexable(page.parsed, page.headers);

      if (!robotsBlocked && !metaCheck.isIndexable) {
        type1.push(page.url);
      } else if (robotsBlocked && metaCheck.isIndexable) {
        type2.push(page.url);
      }
    }

    return { checks: buildChecks(type1, type2) };
  },
};
