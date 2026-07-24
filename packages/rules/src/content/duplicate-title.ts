// content/duplicate-title - Duplicate title detection across site

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { SiteQuery } from "@squirrelscan/core-contracts";

const SKIP_CHECK: CheckResult = {
  name: "duplicate-title",
  status: "skipped",
  message: "Insufficient pages to check for duplicates",
};

// First-seen-ordered duplicate groups (>1 url) from a title→urls map. Shared so
// the legacy and streaming paths produce an identical `duplicates` list.
function findDuplicates(
  titleToUrls: Map<string, string[]>
): { title: string; urls: string[] }[] {
  const duplicates: { title: string; urls: string[] }[] = [];
  for (const [title, urls] of titleToUrls) {
    if (urls.length > 1) {
      duplicates.push({ title, urls });
    }
  }
  return duplicates;
}

// Shared result builder — identical output regardless of how the map was built.
function buildCheck(duplicates: { title: string; urls: string[] }[]): CheckResult {
  if (duplicates.length > 0) {
    const totalDuplicatePages = duplicates.reduce(
      (sum, d) => sum + d.urls.length,
      0
    );
    return {
      name: "duplicate-title",
      status: "warn",
      message: `${duplicates.length} duplicate title(s) found across ${totalDuplicatePages} pages`,
      items: duplicates.map((d) => ({
        id: d.title.substring(0, 60),
        label: `"${d.title.substring(0, 40)}..." (${d.urls.length} pages)`,
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
    name: "duplicate-title",
    status: "pass",
    message: "All pages have unique titles",
  };
}

// Streaming path (#1022): build the title→urls map from page_features scalars via
// the async cursor, in normalized_url order (== the legacy site.pages order),
// re-deriving the lowercase/trim key exactly as the legacy path does. Keeps only
// bounded scalars resident — no parsed pages.
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const checks: CheckResult[] = [];
  if (siteQuery.pageCount() < 2) {
    checks.push(SKIP_CHECK);
    return { checks };
  }

  const titleToUrls = new Map<string, string[]>();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const title = row.title?.trim().toLowerCase();
    if (!title) continue;

    const urls = titleToUrls.get(title) || [];
    urls.push(row.normalizedUrl);
    titleToUrls.set(title, urls);
  }

  checks.push(buildCheck(findDuplicates(titleToUrls)));
  return { checks };
}

export const duplicateTitleRule: Rule = {
  meta: {
    id: "content/duplicate-title",
    name: "Duplicate Title",
    description: "Checks for duplicate title tags across the site",
    solution:
      "Each page should have a unique title tag that accurately describes its content. Duplicate titles confuse search engines about which page to rank and make your pages less distinguishable in search results. Use unique, descriptive titles that include relevant keywords. For similar pages (e.g., pagination), add differentiating elements like page numbers or category names.",
    category: "content",
    scope: "site",
    severity: "warning",
    weight: 6,
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

    // Group pages by title
    const titleToUrls = new Map<string, string[]>();

    for (const page of pages) {
      const title = page.parsed.meta.title?.trim().toLowerCase();
      if (!title) continue;

      const urls = titleToUrls.get(title) || [];
      urls.push(page.url);
      titleToUrls.set(title, urls);
    }

    checks.push(buildCheck(findDuplicates(titleToUrls)));
    return { checks };
  },
};
