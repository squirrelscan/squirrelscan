// crawl/indexable-search-results (#1696)

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { indexableSearchResults } from "../src/crawl/indexable-search-results";
import type { CheckResult, RuleContext } from "../src/types";

const ORIGIN = "https://example.com";

interface PageOpts {
  title?: string;
  h1?: string;
  head?: string;
  status?: number;
  headers?: Record<string, string>;
  soft404?: boolean;
}

function page(path: string, o: PageOpts = {}) {
  const url = `${ORIGIN}${path}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
    o.title ?? "Page"
  }</title>${o.head ?? ""}</head><body><h1>${o.h1 ?? "Heading"}</h1></body></html>`;
  const parsed = parsePage(html, url);
  if (o.soft404) parsed.isSoft404 = true;
  return { url, statusCode: o.status ?? 200, headers: o.headers ?? {}, parsed };
}

function check(pages: ReturnType<typeof page>[], robotsTxt: unknown = null): CheckResult {
  const ctx = {
    options: {},
    site: { baseUrl: ORIGIN, pages, robotsTxt, sitemaps: null },
  } as unknown as RuleContext;
  const result = indexableSearchResults.run(ctx) as { checks: CheckResult[] };
  expect(result.checks).toHaveLength(1);
  return result.checks[0]!;
}

const searchActionLd = (target: string) =>
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    url: ORIGIN,
    potentialAction: {
      "@type": "SearchAction",
      target,
      "query-input": "required name=search_term_string",
    },
  })}</script>`;

describe("crawl/indexable-search-results", () => {
  test("meta declares a site rule in the crawl category", () => {
    expect(indexableSearchResults.meta.id).toBe("crawl/indexable-search-results");
    expect(indexableSearchResults.meta.scope).toBe("site");
    expect(indexableSearchResults.meta.severity).toBe("warning");
    expect(indexableSearchResults.meta.solution).toContain("noindex");
    expect(indexableSearchResults.meta.solution).toContain("robots.txt");
  });

  test("no pages: skipped", () => {
    expect(check([]).status).toBe("skipped");
  });

  test("no search URLs: skipped with reason", () => {
    const c = check([page("/"), page("/about")]);
    expect(c.status).toBe("skipped");
    expect(c.message).toBe("No internal search result URLs in the crawl");
  });

  test("/search?q=x indexable: warn with counts and path+query", () => {
    const c = check([page("/"), page("/search?q=shoes")]);
    expect(c.status).toBe("warn");
    expect(c.message).toBe("1 internal search result URL(s) found, 1 indexable");
    expect(c.value).toContain("/search?q=shoes");
  });

  test("search form page without a query is not a search URL", () => {
    const c = check([page("/search", { head: "", h1: "Search" }), page("/search?q=")]);
    expect(c.status).toBe("skipped");
  });

  test("/Search/ trailing slash is case-insensitive", () => {
    expect(check([page("/Search/?foo=bar")]).status).toBe("warn");
  });

  test("meta noindex: not listed, still counted as found", () => {
    const c = check([page("/search?q=a", { head: '<meta name="robots" content="noindex">' })]);
    expect(c.status).toBe("pass");
    expect(c.message).toBe("1 internal search result URL(s) found, none indexable");
  });

  test("X-Robots-Tag noindex: not listed", () => {
    const c = check([page("/search?q=a", { headers: { "x-robots-tag": "noindex" } })]);
    expect(c.status).toBe("pass");
  });

  test("robots.txt disallow: not listed", () => {
    const robotsTxt = {
      exists: true,
      url: `${ORIGIN}/robots.txt`,
      content: "User-agent: *\nDisallow: /search",
      sizeBytes: 30,
      sitemaps: [],
      errors: [],
      rules: [{ userAgent: "*", rules: [{ type: "disallow", path: "/search" }] }],
    };
    const blocked = check([page("/search?q=a")], robotsTxt);
    expect(blocked.status).toBe("pass");
    expect(blocked.message).toBe("1 internal search result URL(s) found, none indexable");
    expect(check([page("/search?q=a")], null).status).toBe("warn");
  });

  test("canonical to a non-search page: not listed", () => {
    const c = check([
      page("/search?q=a", { head: `<link rel="canonical" href="${ORIGIN}/shop">` }),
    ]);
    expect(c.status).toBe("pass");
  });

  test("canonical to self or another search URL: still listed", () => {
    const self = check([
      page("/search?q=a", { head: `<link rel="canonical" href="${ORIGIN}/search?q=a">` }),
    ]);
    const other = check([
      page("/search?q=a", { head: `<link rel="canonical" href="${ORIGIN}/search?q=b">` }),
    ]);
    expect(self.status).toBe("warn");
    expect(other.status).toBe("warn");
  });

  test("canonical to a parameter-style search URL on another path: still listed", () => {
    const c = check([
      page("/search?q=a", { head: `<link rel="canonical" href="${ORIGIN}/find?s=a">` }),
    ]);
    expect(c.status).toBe("warn");
  });

  test("malformed canonical is ignored", () => {
    const c = check([page("/search?q=a", { head: '<link rel="canonical" href="http://[bad">' })]);
    expect(c.status).toBe("warn");
  });

  test("param s on a category page without evidence is unconfirmed, not listed", () => {
    const c = check([page("/category/shoes?s=red", { title: "Shoes", h1: "Shoes" })]);
    expect(c.status).toBe("skipped");
    expect(c.value).toContain("1 URL(s)");
    const withSearch = check([
      page("/category/shoes?s=red", { title: "Shoes", h1: "Shoes" }),
      page("/search?q=a"),
    ]);
    expect(withSearch.value).toContain("1 unconfirmed");
  });

  test("query value in h1 (or title) confirms a param URL", () => {
    expect(check([page("/?s=red+shoes", { h1: "Results for Red  Shoes" })]).status).toBe("warn");
    expect(check([page("/?q=boots", { title: "boots - Example" })]).status).toBe("warn");
  });

  test("SearchAction /?s={search_term_string} recognises /?s=foo without evidence", () => {
    const c = check([
      page("/", { head: searchActionLd(`${ORIGIN}/?s={search_term_string}`) }),
      page("/?s=foo"),
    ]);
    expect(c.status).toBe("warn");
    expect(c.message).toBe("1 internal search result URL(s) found, 1 indexable");
  });

  test("custom template /find?term={q} (EntryPoint form)", () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: "/find?term={q}" },
      },
    })}</script>`;
    const c = check([page("/", { head: ld }), page("/find?term=abc"), page("/find")]);
    expect(c.message).toBe("1 internal search result URL(s) found, 1 indexable");
  });

  test("path-style template /lookup/{term} matches by prefix", () => {
    const c = check([
      page("/", { head: searchActionLd(`${ORIGIN}/lookup/{term}`) }),
      page("/lookup/abc"),
      page("/lookup/"),
    ]);
    expect(c.message).toBe("1 internal search result URL(s) found, 1 indexable");
  });

  test("malformed SearchAction target is ignored", () => {
    const c = check([page("/", { head: searchActionLd("http://[bad/{q}") }), page("/about")]);
    expect(c.status).toBe("skipped");
  });

  test("non-2xx and soft-404 pages are ignored", () => {
    const c = check([
      page("/search?q=a", { status: 404 }),
      page("/search?q=b", { status: 301 }),
      page("/search?q=c", { soft404: true }),
    ]);
    expect(c.status).toBe("skipped");
  });

  test("lists up to 5 sorted, then +K more", () => {
    const pages = ["g", "c", "a", "f", "b", "e", "d"].map((q) => page(`/search?q=${q}`));
    const c = check(pages);
    expect(c.message).toBe("7 internal search result URL(s) found, 7 indexable");
    expect(c.value?.split("\n").slice(0, 6)).toEqual([
      "/search?q=a",
      "/search?q=b",
      "/search?q=c",
      "/search?q=d",
      "/search?q=e",
      "+2 more",
    ]);
  });

  test("same result for any input order", () => {
    const pages = [
      page("/", { head: searchActionLd(`${ORIGIN}/?s={search_term_string}`) }),
      page("/?s=x"),
      page("/search?q=a"),
      page("/search?q=b", { head: '<meta name="robots" content="noindex">' }),
      page("/cat?q=zzz", { title: "Cat" }),
    ];
    const base = JSON.stringify(check(pages));
    const reversed = JSON.stringify(check([...pages].reverse()));
    const rotated = JSON.stringify(check([...pages.slice(2), ...pages.slice(0, 2)]));
    expect(reversed).toBe(base);
    expect(rotated).toBe(base);
  });
});
