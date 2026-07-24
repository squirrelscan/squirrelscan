// core/title-unique - Unique title check (site-scope)

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";
import type { SiteQuery } from "@squirrelscan/core-contracts";

const SKIP_CHECK: CheckResult = {
  name: "title-unique",
  status: "skipped",
  message: "Need multiple pages to check uniqueness",
};

// This rule normalizes titles by lowercasing AND collapsing internal whitespace
// (distinct from content/duplicate-title, which only lowercases).
function normalizeTitle(rawTitle: string): string {
  return rawTitle.toLowerCase().replace(/\s+/g, " ");
}

// First-seen-ordered duplicate groups (>1 url). Shared so the legacy and
// streaming paths produce an identical `duplicates` list.
function findDuplicates(
  titleMap: Map<string, string[]>
): Array<{ title: string; count: number; urls: string[] }> {
  const duplicates: Array<{ title: string; count: number; urls: string[] }> = [];
  for (const [title, urls] of titleMap) {
    if (urls.length > 1) {
      duplicates.push({ title, count: urls.length, urls });
    }
  }
  return duplicates;
}

// Shared result builder — identical output regardless of how the map was built.
function buildCheck(
  duplicates: Array<{ title: string; count: number; urls: string[] }>
): CheckResult {
  if (duplicates.length === 0) {
    return {
      name: "title-unique",
      status: "pass",
      message: "All page titles are unique",
    };
  }

  const totalDuplicatePages = duplicates.reduce((sum, d) => sum + d.count, 0);
  return {
    name: "title-unique",
    status: "warn",
    message: `${duplicates.length} duplicate title(s) affecting ${totalDuplicatePages} pages`,
    items: duplicates.map((d) => ({
      id: d.title.substring(0, 60),
      label: `"${d.title.substring(0, 40)}..." (${d.count} pages)`,
      sourcePages: d.urls,
      meta: { pageCount: d.count },
    })),
    details: {
      totalDuplicates: duplicates.length,
      totalPages: totalDuplicatePages,
    },
  };
}

// Streaming path (#1022): build the normalizedTitle→urls map from page_features
// scalars via the async cursor, in normalized_url order (== the legacy
// site.pages order), re-deriving the key exactly as the legacy path does.
async function runViaSiteQuery(siteQuery: SiteQuery): Promise<RuleResult> {
  const checks: CheckResult[] = [];
  if (siteQuery.pageCount() < 2) {
    checks.push(SKIP_CHECK);
    return { checks };
  }

  const titleMap = new Map<string, string[]>();
  for await (const row of siteQuery.pagesMatching(() => true)) {
    const title = row.title?.trim() || "";
    if (!title) continue;

    const normalizedTitle = normalizeTitle(title);
    if (!titleMap.has(normalizedTitle)) {
      titleMap.set(normalizedTitle, []);
    }
    titleMap.get(normalizedTitle)!.push(row.normalizedUrl);
  }

  checks.push(buildCheck(findDuplicates(titleMap)));
  return { checks };
}

export const titleUniqueRule: Rule = {
  meta: {
    id: "core/title-unique",
    name: "Title Uniqueness",
    description: "Checks that page titles are unique across the site",
    solution:
      "Each page should have a unique title that accurately describes its content. Duplicate titles confuse search engines and users about which page to display. Use a pattern like 'Page Topic | Brand Name' to ensure uniqueness. CMS often generate duplicate titles - audit and customize them.",
    category: "core",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.siteQuery) {
      return runViaSiteQuery(ctx.siteQuery);
    }

    const checks: CheckResult[] = [];

    if (!ctx.site?.pages || ctx.site.pages.length < 2) {
      checks.push(SKIP_CHECK);
      return { checks };
    }

    // Collect all titles and their pages
    const titleMap = new Map<string, string[]>();

    for (const page of ctx.site.pages) {
      const title = page.parsed.meta.title?.trim() || "";
      if (!title) continue;

      // Normalize for comparison (lowercase, collapse whitespace)
      const normalizedTitle = normalizeTitle(title);

      if (!titleMap.has(normalizedTitle)) {
        titleMap.set(normalizedTitle, []);
      }
      titleMap.get(normalizedTitle)!.push(page.url);
    }

    checks.push(buildCheck(findDuplicates(titleMap)));
    return { checks };
  },
};
