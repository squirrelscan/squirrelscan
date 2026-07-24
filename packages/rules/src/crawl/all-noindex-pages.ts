import { z } from "zod";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

import { matchesExcludePattern } from "@squirrelscan/utils";
import { isPageIndexable, isRobotsTxtDisallowed } from "@squirrelscan/utils";
import { getPathname } from "@squirrelscan/utils";

interface NoindexPage {
  url: string;
  sources: string[];
}
interface Buckets {
  error: NoindexPage[];
  warn: NoindexPage[];
  info: NoindexPage[];
}

// Bucket one non-indexable page by pattern severity — shared by both paths.
function classify(
  url: string,
  reasons: string[],
  warnPatterns: string[],
  errorPatterns: string[],
  buckets: Buckets
): void {
  if (reasons.length === 0) return; // indexable — nothing to report
  const pageData = { url, sources: reasons };
  if (matchesExcludePattern(url, errorPatterns)) {
    buckets.error.push(pageData);
  } else if (matchesExcludePattern(url, warnPatterns)) {
    buckets.warn.push(pageData);
  } else {
    buckets.info.push(pageData);
  }
}

// Shared output builder — identical CheckResult[] for identical buckets.
function buildChecks(buckets: Buckets): CheckResult[] {
  const checks: CheckResult[] = [];

  if (buckets.error.length > 0) {
    const pathList = buckets.error
      .slice(0, 5)
      .map((p) => `${getPathname(p.url)} (${p.sources.join(", ")})`)
      .join("\n");
    const suffix = buckets.error.length > 5 ? `\n+${buckets.error.length - 5} more` : "";
    checks.push({
      name: "critical-noindex",
      status: "fail",
      message: `${buckets.error.length} critical page(s) blocked from indexing (match error patterns)`,
      value: pathList + suffix,
    });
  }

  if (buckets.warn.length > 0) {
    const pathList = buckets.warn
      .slice(0, 5)
      .map((p) => `${getPathname(p.url)} (${p.sources.join(", ")})`)
      .join("\n");
    const suffix = buckets.warn.length > 5 ? `\n+${buckets.warn.length - 5} more` : "";
    checks.push({
      name: "important-noindex",
      status: "warn",
      message: `${buckets.warn.length} important page(s) blocked from indexing (match warning patterns)`,
      value: pathList + suffix,
    });
  }

  if (buckets.info.length > 0) {
    const pathList = buckets.info
      .slice(0, 10)
      .map((p) => `${getPathname(p.url)} (${p.sources.join(", ")})`)
      .join("\n");
    const suffix = buckets.info.length > 10 ? `\n+${buckets.info.length - 10} more` : "";
    checks.push({
      name: "all-noindex",
      status: "info",
      message: `${buckets.info.length} page(s) blocked from indexing`,
      value: pathList + suffix,
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "all-noindex",
      status: "pass",
      message: "All pages are indexable",
    });
  }

  return checks;
}

// Reconstruct the 4-arg isPageIndexable reasons from the pre-extracted 2-arg
// (meta+header) reasons + the site-level robots.txt test, in the SAME push order
// isPageIndexable uses (meta, header, then robots.txt).
function fullReasons(
  storedReasons: string[],
  url: string,
  robotsTxt: RobotsTxtData | null | undefined
): string[] {
  const reasons = [...storedReasons];
  if (robotsTxt && isRobotsTxtDisallowed(url, robotsTxt)) {
    reasons.push("robots.txt:disallowed");
  }
  return reasons;
}

async function runViaSiteQuery(
  siteQuery: SiteQuery,
  robotsTxt: RobotsTxtData | null | undefined,
  warnPatterns: string[],
  errorPatterns: string[]
): Promise<RuleResult> {
  const buckets: Buckets = { error: [], warn: [], info: [] };
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const reasons = fullReasons(row.indexableReasons, row.normalizedUrl, robotsTxt);
    classify(row.normalizedUrl, reasons, warnPatterns, errorPatterns, buckets);
  }
  return { checks: buildChecks(buckets) };
}

export const allNoindexPages: Rule = {
  meta: {
    id: "crawl/all-noindex-pages",
    name: "All Non-Indexed Pages",
    description: "Lists all pages blocked from indexing for user audit",
    solution:
      "Review this list to ensure all non-indexed pages are intentionally blocked. Common unintentional blocks: staging directives left in production, overly broad robots.txt rules, CMS defaults. Remove noindex from pages that should be indexed.",
    category: "crawl",
    scope: "site",
    severity: "info",
    weight: 2,
  },

  optionsSchema: z.object({
    warnOnPatterns: z
      .array(z.string())
      .default([])
      .describe(
        "URL patterns that should trigger warning severity if noindex (e.g., '/blog/', '/products/')"
      ),
    errorOnPatterns: z
      .array(z.string())
      .default([])
      .describe(
        "URL patterns that should trigger error severity if noindex (e.g., '/landing-pages/')"
      ),
  }),

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const options = ctx.options;
    const warnPatterns = (options.warnOnPatterns as string[]) || [];
    const errorPatterns = (options.errorOnPatterns as string[]) || [];
    const robotsTxt = ctx.site?.robotsTxt;

    if (ctx.siteQuery) {
      if (ctx.siteQuery.pageCount() === 0) {
        return {
          checks: [{ name: "all-noindex", status: "skipped", message: "No pages to check" }],
        };
      }
      return runViaSiteQuery(ctx.siteQuery, robotsTxt, warnPatterns, errorPatterns);
    }

    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      return {
        checks: [{ name: "all-noindex", status: "skipped", message: "No pages to check" }],
      };
    }

    const buckets: Buckets = { error: [], warn: [], info: [] };

    for (const page of pages) {
      const check = isPageIndexable(page.parsed, page.headers, page.url, robotsTxt);
      if (!check.isIndexable) {
        classify(page.url, check.reasons, warnPatterns, errorPatterns, buckets);
      }
    }

    return { checks: buildChecks(buckets) };
  },
};
