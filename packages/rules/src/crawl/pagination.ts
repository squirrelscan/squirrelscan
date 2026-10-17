// crawl/pagination - Pagination canonical handling

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { documentUrl } from "../shared/redirect-evidence";

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

    // Detect if this is a paginated page, by the URL it ended on (pub#864).
    const pageUrl = documentUrl(ctx.page);
    const url = new URL(pageUrl);
    const isPaginatedByParam = /[?&](page|p|pg|offset|start)=/i.test(pageUrl);
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
      const canonicalParsed = new URL(canonicalUrl, pageUrl);
      const canonicalIsPaginated =
        /[?&](page|p|pg|offset|start)=/i.test(canonicalParsed.href) ||
        /\/page\/\d+\/?$/.test(canonicalParsed.pathname);

      // pub#826: page 1 of a list is the same content as its unpaginated URL,
      // so a canonical pointing at that URL is correct. Only page 2 and later
      // must canonicalize to themselves. A first page canonicalizing anywhere
      // else still warns.
      const firstPageToBase =
        isFirstPage(url) && sameResource(canonicalParsed, unpaginated(url));
      if (!canonicalIsPaginated && isPaginated && !firstPageToBase) {
        checks.push({
          name: "pagination-canonical",
          status: "warn",
          message: "Paginated page canonicalizes to non-paginated URL",
          value: `Page ${extractPageNumber(pageUrl)} → ${canonicalUrl}`,
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

const PAGINATION_PARAMS = new Set(["page", "p", "pg", "offset", "start"]);

/** `url` with its pagination markers removed: the params above, and a trailing `/page/N`. */
function unpaginated(url: URL): URL {
  const out = new URL(url.href);
  for (const key of [...out.searchParams.keys()]) {
    if (PAGINATION_PARAMS.has(key.toLowerCase())) out.searchParams.delete(key);
  }
  out.pathname = out.pathname.replace(/\/page\/\d+\/?$/, "/");
  return out;
}

/** Same origin, path (trailing slash ignored) and query, fragment ignored. */
function sameResource(a: URL, b: URL): boolean {
  const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
  // Keys sorted, each key's values in their own order (a server may read the
  // first), and every pair re-encoded so `a%26b=c` is not `a&b=c`.
  const query = (u: URL) =>
    JSON.stringify(
      [...new Set(u.searchParams.keys())]
        .sort()
        .map((key) => [key, u.searchParams.getAll(key)]),
    );
  return a.origin === b.origin && path(a) === path(b) && query(a) === query(b);
}

/**
 * True for the first page of a list in any of the spellings this rule
 * recognises. `p` is one of them, as the rule's pagination detection already
 * counts it, though WordPress also uses `?p=` for a post id; a `?p=1` page is
 * exempt only when its canonical is the same URL without it.
 * The spellings: `?page=1` (or `p`, `pg`), an empty or `0` page value (0-indexed
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
