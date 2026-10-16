// pub#864: core/canonical and crawl/pagination judge a redirected page by the
// URL an HTTP redirect ended on, as i18n/hreflang does since pub#827. The crawl
// stores the target's response under the source URL, so the page URL is the
// pre-redirect one. No redirect, a client-side hop or an end that will not
// parse keeps the page URL.

import { describe, expect, test } from "bun:test";

import type { RedirectChain } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { canonicalRule } from "../src/core/canonical";
import { paginationRule } from "../src/crawl/pagination";
import type { Rule, RuleContext } from "../src/types";

function checks(rule: Rule, url: string, head: string, redirectChain?: RedirectChain): string[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body></body></html>`;
  const ctx = {
    page: {
      url,
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
      ...(redirectChain ? { redirectChain, finalUrl: redirectChain.finalUrl } : {}),
    },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("unexpected async rule");
  return result.checks.map((c) => `${c.name}:${c.status}`);
}

function moved(from: string, to: string, type: "http" | "javascript" = "http", status = 301): RedirectChain {
  return {
    sourceUrl: from,
    finalUrl: to,
    hops: [
      { url: from, statusCode: status, type },
      { url: to, statusCode: 200, type: "http" },
    ],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

describe("core/canonical on a redirected page (pub#864)", () => {
  const OLD = "https://example.com/en/old-slug";
  const NEW = "https://example.com/en/new-slug";
  const canonical = `<link rel="canonical" href="${NEW}">`;

  test("a 301 target whose canonical is the final URL is self-referential", () => {
    expect(checks(canonicalRule, OLD, canonical, moved(OLD, NEW))).toContain("canonical:pass");
  });

  test("the target itself, crawled directly, is self-referential as before", () => {
    expect(checks(canonicalRule, NEW, canonical)).toContain("canonical:pass");
  });

  test("no observed redirect, a client-side hop or an unparseable end keeps the page URL", () => {
    expect(checks(canonicalRule, OLD, canonical)).toContain("canonical:info");
    expect(checks(canonicalRule, OLD, canonical, moved(OLD, NEW, "javascript", 200))).toContain("canonical:info");
    expect(checks(canonicalRule, OLD, canonical, moved(OLD, NEW, "http", 0))).toContain("canonical:info");
    expect(checks(canonicalRule, OLD, canonical, moved(OLD, "not a url"))).toContain("canonical:info");
  });
});

describe("crawl/pagination on a redirected page (pub#864)", () => {
  test("a source that 301s to page 2 is judged as page 2, its relative canonical resolved there", () => {
    const from = "https://example.com/blog/older";
    const to = "https://example.com/blog?page=2";
    // `?page=2` is relative to the final URL: self-referencing, so it passes.
    expect(checks(paginationRule, from, '<link rel="canonical" href="?page=2">', moved(from, to))).toContain(
      "pagination-canonical:pass",
    );
    // Page 2 canonicalizing to the list root still warns, as it does unredirected.
    expect(checks(paginationRule, from, '<link rel="canonical" href="/blog">', moved(from, to))).toContain(
      "pagination-canonical:warn",
    );
  });

  test("a paginated source that 301s to a plain page is not judged as paginated", () => {
    const from = "https://example.com/blog?page=2";
    const to = "https://example.com/blog/archive";
    expect(checks(paginationRule, from, '<link rel="canonical" href="/blog/archive">', moved(from, to))).toEqual([
      "pagination:skipped",
    ]);
    // Without the redirect it is page 2 of the list, as before.
    expect(checks(paginationRule, from, '<link rel="canonical" href="/blog/archive">')).toContain(
      "pagination-canonical:warn",
    );
  });

  test("an unparseable end keeps the page URL", () => {
    const from = "https://example.com/blog?page=2";
    expect(checks(paginationRule, from, '<link rel="canonical" href="/blog">', moved(from, "not a url"))).toContain(
      "pagination-canonical:warn",
    );
  });
});
