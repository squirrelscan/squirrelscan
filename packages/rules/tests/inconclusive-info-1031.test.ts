// #1031: an `info` that means "could not judge" carries `details.inconclusive`, so resolution does not
// read it as evidence the page is clean; an `info` that means "nothing found" does not.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { formLabelsRule } from "../src/a11y/form-labels";
import { keywordStuffingRule } from "../src/content/keyword-stuffing";
import { readingLevelRule } from "../src/content/reading-level";
import type { ParsedPage, Rule, RuleContext } from "../src/types";

function run(rule: Rule, html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {} }, parsed: parsePage(html, url) as ParsedPage, options: {} } as RuleContext;
  return rule.run(ctx).checks as CheckResult[];
}

const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;

describe("inconclusive vs nothing-found infos (#1031)", () => {
  test("content too short to judge is inconclusive (keyword-stuffing, reading-level)", () => {
    const html = page("<p>Short page.</p>");
    for (const rule of [keywordStuffingRule, readingLevelRule]) {
      const info = run(rule, html).find((c) => c.status === "info");
      expect(info, rule.meta.id).toBeDefined();
      expect(info!.details?.inconclusive, rule.meta.id).toBe(true);
    }
  });

  test('"No form inputs found" is a verdict, not inconclusive', () => {
    const info = run(formLabelsRule, page("<p>Hello</p>")).find((c) => c.status === "info");
    expect(info?.message).toBe("No form inputs found");
    expect(info?.details?.inconclusive).toBeUndefined();
  });
});
