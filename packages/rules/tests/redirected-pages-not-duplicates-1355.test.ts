// #1355: a page that redirected to another URL carries that URL's content, so
// duplicate title and description count it once, where it is served from.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { redirectedAway } from "@squirrelscan/utils/url";

import { titleUniqueRule } from "../src/core/title-unique";
import { duplicateDescriptionRule } from "../src/content/duplicate-description";
import { duplicateTitleRule } from "../src/content/duplicate-title";
import type { Rule, RuleContext, SiteData } from "../src/types";

const BASE = "https://shop.example";
const doc = (title: string, description: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="${description}"></head><body><h1>${title}</h1></body></html>`;

function site(pages: Array<{ url: string; finalUrl?: string; title: string; description: string }>): SiteData {
  return {
    baseUrl: BASE,
    pages: pages.map((p) => ({
      url: p.url,
      ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}),
      statusCode: 200,
      parsed: parsePage(doc(p.title, p.description), p.url) as never,
    })),
    robotsTxt: null,
    sitemaps: null,
  };
}

function statuses(rule: Rule, data: SiteData): string[] {
  const ctx = {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as never,
    site: data,
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("unexpected async rule");
  return result.checks.map((c) => c.status);
}

const SAME = { title: "Saddle shop", description: "English description of the saddle shop" };

describe("redirectedAway", () => {
  test("a different final page is a redirect; the same page, a trailing slash or no final url is not", () => {
    expect(redirectedAway(`${BASE}/de-ch`, `${BASE}/en`)).toBe(true);
    expect(redirectedAway(`${BASE}/en`, `${BASE}/en`)).toBe(false);
    expect(redirectedAway(`${BASE}/en/`, `${BASE}/en`)).toBe(false);
    expect(redirectedAway(`${BASE}/en`, undefined)).toBe(false);
    expect(redirectedAway(`${BASE}/en`, "")).toBe(false);
    // A query is part of the page.
    expect(redirectedAway(`${BASE}/p?a=1`, `${BASE}/p?a=2`)).toBe(true);
  });
});

describe("duplicate title and description ignore a requested url that redirected", () => {
  const redirected = site([
    { url: `${BASE}/en`, ...SAME },
    { url: `${BASE}/de-ch`, finalUrl: `${BASE}/en`, ...SAME },
    { url: `${BASE}/fr-ch`, finalUrl: `${BASE}/en`, ...SAME },
  ]);
  const real = site([
    { url: `${BASE}/en`, ...SAME },
    { url: `${BASE}/de-ch`, ...SAME },
  ]);

  for (const [name, rule] of [
    ["content/duplicate-description", duplicateDescriptionRule],
    ["content/duplicate-title", duplicateTitleRule],
    ["core/title-unique", titleUniqueRule],
  ] as const) {
    test(`${name}: redirected urls are not duplicates of the target`, () => {
      expect(statuses(rule, redirected)).not.toContain("warn");
    });
    test(`${name}: two real pages with the same text still are`, () => {
      expect(statuses(rule, real)).toContain("warn");
    });
  }
});
