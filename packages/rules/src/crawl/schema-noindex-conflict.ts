import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { RobotsTxtData, SiteQuery } from "@squirrelscan/core-contracts";

import { isPageIndexable, getRichResultTypes, isRobotsTxtDisallowed } from "@squirrelscan/utils";
import { getPathname } from "@squirrelscan/utils";
import { sampleUrlItems } from "../shared/sample-items";

interface Conflict {
  url: string;
  schemaTypes: string[];
  blockSource: string[];
}

const SKIP_CHECK: CheckResult = {
  name: "schema-noindex",
  status: "skipped",
  message: "No pages to check",
};

// Shared output builder — identical CheckResult given the same conflict list.
function buildCheck(unsorted: Conflict[]): CheckResult {
  // Sorted, so the sample (and the finding's identity) does not follow crawl order.
  const conflicts = [...unsorted].sort((a, b) => a.url.localeCompare(b.url));
  if (conflicts.length > 0) {
    const details = conflicts
      .slice(0, 5)
      .map(
        (c) =>
          `${getPathname(c.url)}\n` +
          `  Schema: ${c.schemaTypes.join(", ")}\n` +
          `  Blocked by: ${c.blockSource.join(", ")}`
      )
      .join("\n\n");
    const suffix = conflicts.length > 5 ? `\n\n+${conflicts.length - 5} more` : "";
    // #1735: the page list and each page's evidence as structured data, not only in `value`.
    // `pages` and the items are the capped sample; `pagesTruncated` and `occurrences` hold the true count.
    const sample = sampleUrlItems(
      conflicts.map((c) => ({
        id: c.url,
        label: `Schema: ${c.schemaTypes.join(", ")}. Blocked by: ${c.blockSource.join(", ")}`,
        meta: { schemaTypes: c.schemaTypes, blockedBy: c.blockSource },
      })),
    );
    return {
      name: "schema-noindex",
      status: "fail",
      message: `${conflicts.length} page(s) have rich schema but are blocked from indexing`,
      value: details + suffix,
      pages: sample.items.map((item) => item.id),
      items: sample.items,
      details: { occurrences: conflicts.length, pagesTruncated: conflicts.length, ...sample.truncation },
    };
  }
  return {
    name: "schema-noindex",
    status: "pass",
    message: "No schema+noindex conflicts",
  };
}

// 4-arg isPageIndexable reasons reconstructed from the pre-extracted 2-arg
// (meta+header) reasons + the site-level robots.txt test (same push order).
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
  robotsTxt: RobotsTxtData | null | undefined
): Promise<RuleResult> {
  const conflicts: Conflict[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const richTypes = row.richResultTypes;
    if (richTypes.length === 0) continue;
    const reasons = fullReasons(row.indexableReasons, row.normalizedUrl, robotsTxt);
    if (reasons.length > 0) {
      conflicts.push({ url: row.normalizedUrl, schemaTypes: richTypes, blockSource: reasons });
    }
  }
  return { checks: [buildCheck(conflicts)] };
}

export const schemaNoindexConflict: Rule = {
  meta: {
    id: "crawl/schema-noindex-conflict",
    name: "Schema + Noindex Conflict",
    description:
      "Detects pages with rich result schema that are blocked from indexing",
    solution:
      "Pages with rich result schemas (Article, Product, Recipe, Event, etc.) should be indexed so search engines can display rich results. Having schema markup on noindexed pages wastes effort and prevents rich results from appearing. Remove noindex directive or remove schema markup if page shouldn't be indexed.",
    category: "crawl",
    scope: "site",
    severity: "error",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const robotsTxt = ctx.site?.robotsTxt;

    if (ctx.siteQuery) {
      if (ctx.siteQuery.pageCount() === 0) {
        return { checks: [SKIP_CHECK] };
      }
      return runViaSiteQuery(ctx.siteQuery, robotsTxt);
    }

    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      return { checks: [SKIP_CHECK] };
    }

    const conflicts: Conflict[] = [];

    for (const page of pages) {
      const richTypes = getRichResultTypes(page.parsed.schemas);

      if (richTypes.length === 0) continue;

      const check = isPageIndexable(page.parsed, page.headers, page.url, robotsTxt);

      if (!check.isIndexable) {
        conflicts.push({
          url: page.url,
          schemaTypes: richTypes,
          blockSource: check.reasons,
        });
      }
    }

    return { checks: [buildCheck(conflicts)] };
  },
};
