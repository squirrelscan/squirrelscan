// content/duplicate-description - Duplicate meta description detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { SiteQuery } from "@squirrelscan/core-contracts";

const SKIP_CHECK: CheckResult = {
  name: "duplicate-description",
  status: "skipped",
  message: "Insufficient pages to check for duplicates",
};

// First-seen-ordered duplicate groups (>1 url) from a desc→urls map. Shared so
// the legacy and streaming paths produce an identical `duplicates` list.
function findDuplicates(
  descToUrls: Map<string, string[]>
): { desc: string; urls: string[] }[] {
  const duplicates: { desc: string; urls: string[] }[] = [];
  for (const [desc, urls] of descToUrls) {
    if (urls.length > 1) {
      duplicates.push({ desc, urls });
    }
  }
  return duplicates;
}

// Shared result builder — identical output regardless of how the map was built.
function buildCheck(duplicates: { desc: string; urls: string[] }[]): CheckResult {
  if (duplicates.length > 0) {
    const totalDuplicatePages = duplicates.reduce(
      (sum, d) => sum + d.urls.length,
      0
    );
    return {
      name: "duplicate-description",
      status: "warn",
      message: `${duplicates.length} duplicate description(s) found across ${totalDuplicatePages} pages`,
      items: duplicates.map((d) => ({
        id: d.desc.substring(0, 60),
        label: `"${d.desc.substring(0, 40)}..." (${d.urls.length} pages)`,
        sourcePages: d.urls,
        meta: { pageCount: d.urls.length },
      })),
      details: {
        totalDuplicates: duplicates.length,
        totalPages: totalDuplicatePages,
      },
    };
  }
  return {
    name: "duplicate-description",
    status: "pass",
    message: "All pages have unique meta descriptions",
  };
}

// Streaming path (#1022): build the desc→urls map from page_features scalars via
// the async cursor, in normalized_url order (== the legacy site.pages order),
// re-deriving the lowercase/trim key exactly as the legacy path does.
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const checks: CheckResult[] = [];
  if (siteQuery.pageCount() < 2) {
    checks.push(SKIP_CHECK);
    return { checks };
  }

  const descToUrls = new Map<string, string[]>();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const desc = row.description?.trim().toLowerCase();
    if (!desc) continue;

    const urls = descToUrls.get(desc) || [];
    urls.push(row.normalizedUrl);
    descToUrls.set(desc, urls);
  }

  checks.push(buildCheck(findDuplicates(descToUrls)));
  return { checks };
}

export const duplicateDescriptionRule: Rule = {
  meta: {
    id: "content/duplicate-description",
    name: "Duplicate Description",
    description: "Checks for duplicate meta descriptions across the site",
    solution:
      "Each page should have a unique meta description that summarizes its specific content. Duplicate descriptions reduce click-through rates and provide poor user experience in search results. Write unique, compelling descriptions for each page. For pages without unique content (like paginated results), consider using no description rather than a duplicate.",
    category: "content",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery);
    }

    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length < 2) {
      checks.push(SKIP_CHECK);
      return { checks };
    }

    // Group pages by description
    const descToUrls = new Map<string, string[]>();

    for (const page of pages) {
      const desc = page.parsed.meta.description?.trim().toLowerCase();
      if (!desc) continue;

      const urls = descToUrls.get(desc) || [];
      urls.push(page.url);
      descToUrls.set(desc, urls);
    }

    checks.push(buildCheck(findDuplicates(descToUrls)));
    return { checks };
  },
};
