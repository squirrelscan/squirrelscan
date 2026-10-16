// crawl/pagination - Pagination canonical handling

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const paginationRule: Rule = {
  meta: {
    id: "crawl/pagination",
    name: "Pagination",
    description: "Checks that paginated pages have proper canonicals",
    solution:
      "Paginated pages should NOT all canonicalize to page 1. Each page should have a self-referencing canonical. Use rel='next' and rel='prev' links to indicate pagination sequence (though Google no longer uses these for indexing, they help users). Consider view-all pages or infinite scroll as alternatives. Ensure each paginated page has unique, valuable content.",
    category: "crawl",
    scope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Detect if this is a paginated page
    const url = new URL(ctx.page.url);
    const isPaginatedByParam = /[?&](page|p|pg|offset|start)=/i.test(
      ctx.page.url
    );
    const isPaginatedByPath = /\/page\/\d+\/?$/.test(url.pathname);
    const isPaginated = isPaginatedByParam || isPaginatedByPath;

    // Check for pagination links
    const nextLink = doc.querySelector('link[rel="next"]');
    const prevLink = doc.querySelector('link[rel="prev"]');
    const hasPaginationLinks = nextLink || prevLink;

    if (!isPaginated && !hasPaginationLinks) {
      checks.push({
        name: "pagination",
        status: "skipped",
        message: "Page does not appear to be paginated",
      });
      return { checks };
    }

    // Get canonical
    const canonical = doc.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonical?.getAttribute("href");

    if (isPaginated && canonicalUrl) {
      // Check if canonical points to page 1
      const canonicalParsed = new URL(canonicalUrl, ctx.page.url);
      const canonicalIsPaginated =
        /[?&](page|p|pg|offset|start)=/i.test(canonicalParsed.href) ||
        /\/page\/\d+\/?$/.test(canonicalParsed.pathname);

      // pub#826: page 1 of a list is the same content as its unpaginated URL,
      // so a canonical pointing there is correct. Only page 2 and later must
      // canonicalize to themselves.
      if (!canonicalIsPaginated && isPaginated && !isFirstPage(url)) {
        checks.push({
          name: "pagination-canonical",
          status: "warn",
          message: "Paginated page canonicalizes to non-paginated URL",
          value: `Page ${extractPageNumber(ctx.page.url)} → ${canonicalUrl}`,
        });
      } else {
        checks.push({
          name: "pagination-canonical",
          status: "pass",
          message: "Paginated page has appropriate canonical",
        });
      }
    }

    // Check for rel=next/prev (informational - Google deprecated but still useful)
    if (hasPaginationLinks) {
      checks.push({
        name: "pagination-links",
        status: "info",
        message: "Pagination links present",
        value: `${prevLink ? "prev" : ""}${prevLink && nextLink ? ", " : ""}${nextLink ? "next" : ""}`,
      });
    } else if (isPaginated) {
      checks.push({
        name: "pagination-links",
        status: "info",
        message: "No rel=next/prev links (optional)",
      });
    }

    return { checks };
  },
};

/**
 * True for the first page of a list in any of the spellings this rule
 * recognises: `?page=1` (or `p`, `pg`), an empty or `0` page value (0-indexed
 * lists), `?offset=0` / `?start=0`, and `/page/1`.
 */
function isFirstPage(url: URL): boolean {
  // Every pagination marker on the URL has to say "first page": `/page/1?page=2`
  // is page 2.
  const path = url.pathname.match(/\/page\/(\d+)\/?$/);
  if (path && !/^0*[01]$/.test(path[1] ?? "")) return false;
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    const v = value.trim();
    if (name === "page" || name === "p" || name === "pg") {
      if (v !== "" && !/^0*[01]$/.test(v)) return false;
    } else if (name === "offset" || name === "start") {
      if (v !== "" && !/^0+$/.test(v)) return false;
    }
  }
  return true;
}

function extractPageNumber(url: string): string {
  // Try query param
  const paramMatch = url.match(/[?&](?:page|p|pg)=(\d+)/i);
  if (paramMatch) return paramMatch[1];

  // Try path
  const pathMatch = url.match(/\/page\/(\d+)/i);
  if (pathMatch) return pathMatch[1];

  return "?";
}
