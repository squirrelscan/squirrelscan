// #1741: a rule that ran says so. Every page-scope rule is run on a clean page and must emit at least one
// check. Six rules still return an empty list when the page has nothing in their scope (no password form, no
// svg role="img", no WebSite schema, no input field, no button); `fixtures/rule-clean-run-empty.json`
// lists them. It only shrinks: a rule that now emits a check must be removed from it, and a new rule that
// returns an empty list fails. A declared rule (`meta.checks`) must emit only names it declares.
//
// Site-scope rules need a crawl context, not a single page, and are not run here. Tracked as a follow-up.
import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { loadAllRules } from "../src/loader";
import type { ParsedPage, Rule, RuleResult } from "../src/types";
import emptyBaseline from "./fixtures/rule-clean-run-empty.json";
import { expectDeclaredChecks } from "./helpers/declared-checks";

const URL = "https://shop.test/p";
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A fine title of a decent length here</title><meta name="description" content="A perfectly reasonable description of the page that is long enough to be useful to readers and search engines alike."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${URL}"></head><body><main><h1>Hello</h1><p>Some text content here.</p><a href="/about">About</a></main></body></html>`;

const pageRules = [...loadAllRules().values()].filter((r) => r.meta.scope === "page");

function runClean(rule: Rule): RuleResult | null {
  try {
    const out = rule.run({
      page: { url: URL, html: HTML, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(HTML, URL) as ParsedPage,
      options: {},
    });
    return out instanceof Promise ? null : out;
  } catch {
    // A rule that needs more than a page (dead-end-pages reads the link graph) is not judged here.
    return null;
  }
}

const results = new Map(pageRules.map((r) => [r.meta.id, runClean(r)]));

describe("a rule that ran emits a check (#1741)", () => {
  test("the page rules that return an empty list on a clean page are exactly the baseline, which only shrinks", () => {
    const empty = pageRules
      .filter((r) => {
        const res = results.get(r.meta.id);
        return res !== null && res !== undefined && res.checks.length === 0;
      })
      .map((r) => r.meta.id)
      .sort();
    const baseline = new Set<string>(emptyBaseline);
    expect(empty.filter((id) => !baseline.has(id)), "a rule that ran must emit a pass or info check").toEqual([]);
    expect(
      [...baseline].filter((id) => !empty.includes(id)),
      "now emits a check: remove from fixtures/rule-clean-run-empty.json",
    ).toEqual([]);
    expect([...emptyBaseline]).toEqual([...new Set(emptyBaseline)].sort());
  });

  test("a declared rule emits only declared check names on a clean page", () => {
    for (const rule of pageRules) {
      const res = results.get(rule.meta.id);
      if (res) expectDeclaredChecks(rule, res.checks);
    }
  });
});
