// content/heading-hierarchy counts only empty headings a reader can see (#547).
// The parser marks the hidden ones; the replayed parse must agree with a fresh one.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { headingHierarchyRule } from "../src/content/heading-hierarchy";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
}

function ctxFor(html: string, parsed = parsePage(html, URL)): RuleContext {
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  } as unknown as RuleContext;
}

function emptyCheck(html: string, parsed?: ReturnType<typeof parsePage>): CheckResult | undefined {
  const result = headingHierarchyRule.run(ctxFor(html, parsed)) as { checks: CheckResult[] };
  return result.checks.find((c) => c.name === "empty-headings");
}

const VISIBLE_TEXT = "<h1>Shop</h1><p>text</p>";

describe("content/heading-hierarchy empty headings (#547)", () => {
  test.each([
    ["hidden attribute", `<h2 hidden></h2>`],
    ["inline display:none", `<h2 style="display:none"></h2>`],
    ["inline visibility:hidden", `<h2 style="visibility:hidden"></h2>`],
    ["hidden ancestor", `<div hidden><h2></h2></div>`],
    ["aria-hidden ancestor", `<div aria-hidden="true"><h2></h2></div>`],
  ])("a hidden empty heading (%s) is not counted", (_label, hidden) => {
    expect(emptyCheck(page(`${VISIBLE_TEXT}${hidden}`))).toBeUndefined();
  });

  test("a visible empty heading is still counted", () => {
    const check = emptyCheck(page(`${VISIBLE_TEXT}<h2></h2>`));
    expect(check?.status).toBe("warn");
    expect(check?.message).toBe("1 empty heading(s) found");
  });

  test("hidden and visible empties in one page count only the visible one", () => {
    const check = emptyCheck(page(`${VISIBLE_TEXT}<h2 hidden></h2><h3></h3>`));
    expect(check?.message).toBe("1 empty heading(s) found");
  });

  test("a replayed parse (JSON round trip) gives the same count as a fresh parse", () => {
    const html = page(`${VISIBLE_TEXT}<h2 hidden></h2><h3></h3>`);
    const fresh = parsePage(html, URL);
    const replayed = JSON.parse(JSON.stringify(fresh));
    expect(emptyCheck(html, replayed)?.message).toBe(emptyCheck(html, fresh)?.message);
  });
});
