// pub#826: crawl/pagination warned that `/blog?page=1` canonicalizes to
// `/blog`. Page 1 of a paginated list is the same content as the unpaginated
// URL, so pointing its canonical there is correct; only page 2 and later must
// canonicalize to themselves.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { paginationRule } from "../src/crawl/pagination";
import type { RuleContext } from "../src/types";

function canonicalCheck(url: string, canonical: string) {
  const html = `<!doctype html><html lang="en"><head><title>Blog</title><link rel="canonical" href="${canonical}"></head><body><h1>Blog</h1></body></html>`;
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  return paginationRule.run(ctx).checks.find((c) => c.name === "pagination-canonical");
}

const B = "https://example.com";

describe("crawl/pagination — the first page (pub#826)", () => {
  test("page 1 in any spelling may canonicalize to the unpaginated URL", () => {
    for (const url of [
      `${B}/blog?page=1`,
      `${B}/blog?page=`,
      `${B}/blog?page=0`,
      `${B}/blog?p=1`,
      `${B}/blog?offset=0`,
      `${B}/blog?start=0`,
      `${B}/blog/page/1`,
      `${B}/blog/page/1/`,
    ]) {
      expect({ url, status: canonicalCheck(url, `${B}/blog`)?.status }).toEqual({ url, status: "pass" });
    }
  });

  test("page 2 and later canonicalizing to the unpaginated URL still warn", () => {
    for (const url of [
      `${B}/blog?page=2`,
      `${B}/blog/page/3`,
      `${B}/blog?offset=20`,
      `${B}/blog?start=10`,
      // Every marker has to say first page.
      `${B}/blog/page/1?page=2`,
      `${B}/blog/page/1?offset=20`,
      // Only 0 and 1 are a first page.
      `${B}/blog?page=-1`,
      `${B}/blog?page=0.5`,
      `${B}/blog?page=-Infinity`,
    ]) {
      expect({ url, status: canonicalCheck(url, `${B}/blog`)?.status }).toEqual({ url, status: "warn" });
    }
  });

  test("a self-referencing canonical passes on any page", () => {
    expect(canonicalCheck(`${B}/blog?page=2`, `${B}/blog?page=2`)?.status).toBe("pass");
    expect(canonicalCheck(`${B}/blog?page=1`, `${B}/blog?page=1`)?.status).toBe("pass");
  });
});
