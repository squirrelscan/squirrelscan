import { parsePage } from "@squirrelscan/parser";
// #1741: a site-scope rule that ran says so, like the page rules in rule-clean-run-checks.test.ts. Every
// site-scope rule is run over a small clean site and must emit at least one check. The rules that still
// return an empty list there, or that need more than this fixture (they throw or answer asynchronously),
// are listed in `fixtures/rule-clean-run-site-empty.json`. It only shrinks: a rule that now emits a check
// must be removed from it, and a new site rule that returns an empty list fails.
import { describe, expect, test } from "bun:test";

import type { ParsedPage, Rule, RuleResult, SiteData } from "../src/types";

import { loadAllRules } from "../src/loader";
import emptyBaseline from "./fixtures/rule-clean-run-site-empty.json";
import { expectDeclaredChecks } from "./helpers/declared-checks";

const ORIGIN = "https://shop.test";

function html(path: string): string {
  const url = `${ORIGIN}${path}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A fine title for ${path} of a decent length</title><meta name="description" content="A perfectly reasonable description of the page that is long enough to be useful to readers and search engines alike."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${url}"></head><body><main><h1>Hello ${path}</h1><p>Some text content here.</p><a href="/">Home</a> <a href="/about">About</a></main></body></html>`;
}

function site(): SiteData {
  return {
    baseUrl: ORIGIN,
    pages: ["/", "/about"].map((path) => ({
      url: `${ORIGIN}${path}`,
      statusCode: 200,
      parsed: parsePage(html(path), `${ORIGIN}${path}`) as ParsedPage,
      headers: {},
    })),
    robotsTxt: null,
    sitemaps: null,
  };
}

const siteRules = [...loadAllRules().values()].filter(
  (r) => r.meta.scope === "site"
);

function runClean(rule: Rule): RuleResult | null {
  const data = site();
  try {
    const out = rule.run({
      page: {
        url: data.baseUrl,
        html: "",
        statusCode: 200,
        loadTime: 0,
        headers: {},
      },
      parsed: data.pages[0]!.parsed,
      site: data,
      options: {},
    });
    return out instanceof Promise ? null : out;
  } catch {
    return null;
  }
}

const results = new Map(siteRules.map((r) => [r.meta.id, runClean(r)]));

describe("a site rule that ran emits a check (#1741)", () => {
  test("the site rules that return no checks on a clean site are exactly the baseline, which only shrinks", () => {
    const unjudged = siteRules
      .filter((r) => {
        const res = results.get(r.meta.id);
        return res === null || res === undefined || res.checks.length === 0;
      })
      .map((r) => r.meta.id)
      .sort();
    const baseline = new Set<string>(emptyBaseline);
    expect(
      unjudged.filter((id) => !baseline.has(id)),
      "a site rule that ran must emit a pass or info check"
    ).toEqual([]);
    expect(
      [...baseline].filter((id) => !unjudged.includes(id)),
      "now emits a check: remove from fixtures/rule-clean-run-site-empty.json"
    ).toEqual([]);
    expect([...emptyBaseline]).toEqual([...new Set(emptyBaseline)].sort());
  });

  test("a declared site rule emits only declared check names on a clean site", () => {
    for (const rule of siteRules) {
      const res = results.get(rule.meta.id);
      if (res) expectDeclaredChecks(rule, res.checks);
    }
  });
});
