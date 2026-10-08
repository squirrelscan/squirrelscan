// The one rule for matching an entity filter's `page` value against a page URL.
//
// `squirrel entities --page`, `GET /v1/reports/:id/entities?page=` and
// `list_entities.page` on both MCP servers used to match three different ways.
// They all call this now, and all four read the same `ENTITY_PAGE_MATCH_CASES`
// table in their tests, so one of them drifting fails a test rather than
// returning a different set of entities from the same map.

/**
 * How a `page` filter value is matched.
 *
 *  - A value that is an absolute `http(s)` URL is a PREFIX of the page URL.
 *  - A value that starts with `/` is a PREFIX of the page's path and query.
 *    `/blog` matches `https://example.com/blog/post` and not
 *    `https://example.com/tag/blog`.
 *  - Anything else is a SUBSTRING of the page URL, so `blog` matches both.
 *
 * Case-sensitive in every mode. The scheme test is deliberately `http(s)`
 * and not "parses as a URL": `localhost:3000/blog` parses, with a scheme of
 * `localhost:`, and a prefix match on it would never find anything.
 */
export type EntityPageMatchMode = "prefix-url" | "prefix-path" | "substring";

const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/** Which of the three rules a filter value selects. */
export function entityPageMatchMode(pattern: string): EntityPageMatchMode {
  if (ABSOLUTE_HTTP_URL.test(pattern)) return "prefix-url";
  if (pattern.startsWith("/")) return "prefix-path";
  return "substring";
}

/** True when the page URL matches the filter value under {@link EntityPageMatchMode}. */
export function matchesEntityPage(pageUrl: string, pattern: string): boolean {
  switch (entityPageMatchMode(pattern)) {
    case "prefix-url":
      return pageUrl.startsWith(pattern);
    case "prefix-path": {
      if (!URL.canParse(pageUrl)) return false;
      const url = new URL(pageUrl);
      return `${url.pathname}${url.search}`.startsWith(pattern);
    }
    case "substring":
      return pageUrl.includes(pattern);
  }
}

/** The filter rule, as shown to an agent in the shared `page` field description. */
export const ENTITY_PAGE_MATCH_RULE =
  'A value that is an absolute http(s) URL or starts with "/" is a PREFIX match: the full URL for the first, the page path and query for the second, so "/blog" matches https://example.com/blog/post but not https://example.com/tag/blog. Any other value is a SUBSTRING match against the URL, so "blog" matches both. Case-sensitive. Not a glob.';

/**
 * Inputs and expected matches, shared by every surface's tests.
 *
 * Each case is one `page` value against one page URL. The CLI, the API and
 * both MCP servers must give every row's `matches` answer.
 */
export const ENTITY_PAGE_MATCH_CASES: ReadonlyArray<{
  pattern: string;
  url: string;
  matches: boolean;
}> = [
  // Absolute URL: prefix of the whole URL.
  { pattern: "https://example.com/blog", url: "https://example.com/blog/post", matches: true },
  { pattern: "https://example.com/blog", url: "https://example.com/blog", matches: true },
  { pattern: "https://example.com/blog", url: "https://example.com/tag/blog", matches: false },
  { pattern: "https://example.com/blog", url: "https://other.example.com/blog/post", matches: false },
  { pattern: "https://example.com/blog", url: "http://example.com/blog/post", matches: false },
  { pattern: "HTTPS://example.com/blog", url: "HTTPS://example.com/blog/post", matches: true },
  // Leading slash: prefix of path and query.
  { pattern: "/blog", url: "https://example.com/blog/post", matches: true },
  { pattern: "/blog", url: "https://example.com/blog", matches: true },
  { pattern: "/blog", url: "https://example.com/tag/blog", matches: false },
  { pattern: "/blog", url: "https://example.com/blog.html", matches: true },
  { pattern: "/blog?page=2", url: "https://example.com/blog?page=2", matches: true },
  { pattern: "/", url: "https://example.com/", matches: true },
  { pattern: "/blog", url: "not a url", matches: false },
  // Anything else: substring.
  { pattern: "blog", url: "https://example.com/blog/post", matches: true },
  { pattern: "blog", url: "https://example.com/tag/blog", matches: true },
  { pattern: "example.com/blog", url: "https://example.com/blog/post", matches: true },
  { pattern: "localhost:3000/blog", url: "http://localhost:3000/blog/post", matches: true },
  { pattern: "shop", url: "https://example.com/blog/post", matches: false },
  // Case-sensitive in every mode.
  { pattern: "Blog", url: "https://example.com/blog/post", matches: false },
  { pattern: "/Blog", url: "https://example.com/blog/post", matches: false },
];
