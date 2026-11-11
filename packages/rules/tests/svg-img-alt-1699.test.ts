// a11y/svg-img-alt: an inline <svg role="img"> needs an accessible name (#1699).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { svgImgAltRule } from "../src/a11y/svg-img-alt";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string, head = ""): CheckResult[] {
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
    wantsItemSelectors: false,
  } as unknown as RuleContext;
  const result = svgImgAltRule.run(ctx);
  if (result instanceof Promise) throw new Error("svg-img-alt is sync");
  return result.checks;
}

const fail = (checks: CheckResult[]) => checks.find((c) => c.status === "fail");
const passes = (checks: CheckResult[]) => checks.length === 1 && checks[0]?.status === "pass";
const nothing = (checks: CheckResult[]) => checks.length === 0;

describe("a name is required", () => {
  test("no title, no aria-label, no aria-labelledby fails, and the finding locates the element", () => {
    const checks = run('<main><svg id="chart" class="big" role="img" viewBox="0 0 10 10"><circle r="4"/></svg></main>');
    const f = fail(checks);
    expect(f?.message).toBe('1 <svg role="img"> element(s) without an accessible name');
    expect(f?.items?.[0]?.id).toContain("svg#chart.big");
    expect(f?.items?.[0]?.snippet).toBe('<svg id="chart" class="big" role="img" viewBox="0 0 10 10">');
    expect(f?.items?.[0]?.label).toContain("no <title>, aria-label or aria-labelledby");
  });

  test("a non-empty direct <title> passes", () => {
    expect(passes(run('<svg role="img"><title>Revenue by quarter</title><rect/></svg>'))).toBe(true);
  });

  test("an empty or whitespace <title> does not name it", () => {
    expect(fail(run('<svg role="img"><title>  </title></svg>'))).toBeDefined();
  });

  test("a <title> deeper than a direct child does not name it", () => {
    expect(fail(run('<svg role="img"><g><title>Nested</title></g></svg>'))).toBeDefined();
  });

  test("a non-empty aria-label passes; an empty one does not", () => {
    expect(passes(run('<svg role="img" aria-label="Logo"></svg>'))).toBe(true);
    expect(fail(run('<svg role="img" aria-label="  "></svg>'))).toBeDefined();
  });

  test("an aria-labelledby that resolves to text on the page passes", () => {
    expect(passes(run('<h2 id="h">Sales</h2><svg role="img" aria-labelledby="h"></svg>'))).toBe(true);
  });

  test("a list of ids passes when one of them resolves to text", () => {
    expect(passes(run('<p id="a">Sales</p><svg role="img" aria-labelledby="missing a"></svg>'))).toBe(true);
  });

  test("an aria-labelledby that points at an id missing from the page fails", () => {
    const f = fail(run('<svg role="img" aria-labelledby="nowhere"></svg>'));
    expect(f).toBeDefined();
    expect(f?.items?.[0]?.label).toContain("aria-labelledby points at an id that is not on the page");
  });

  test("an aria-labelledby that points at an element with no text fails", () => {
    expect(fail(run('<span id="e"></span><svg role="img" aria-labelledby="e"></svg>'))).toBeDefined();
  });

  test("role is read without case and as a first token", () => {
    expect(fail(run('<svg role="IMG"></svg>'))).toBeDefined();
    expect(fail(run('<svg role="img presentation"></svg>'))).toBeDefined();
  });
});

describe("what is not assessed", () => {
  test("an svg with no role is not assessed", () => {
    expect(nothing(run("<svg><circle/></svg>"))).toBe(true);
  });

  test('aria-hidden="true" and role="presentation" are not assessed', () => {
    expect(nothing(run('<svg role="img" aria-hidden="true"></svg>'))).toBe(true);
    expect(nothing(run('<svg role="presentation"></svg>'))).toBe(true);
    expect(nothing(run('<svg role="none"></svg>'))).toBe(true);
  });

  test("an svg hidden from view is not assessed: a hidden ancestor, inline display:none, an aria-hidden ancestor, a closed dialog", () => {
    expect(nothing(run('<div hidden><svg role="img"></svg></div>'))).toBe(true);
    expect(nothing(run('<div style="display:none"><svg role="img"></svg></div>'))).toBe(true);
    expect(nothing(run('<div aria-hidden="true"><svg role="img"></svg></div>'))).toBe(true);
    expect(nothing(run('<dialog><svg role="img"></svg></dialog>'))).toBe(true);
  });

  test("the hidden attribute on the svg itself hides nothing: it is an HTML attribute and an svg element ignores it", () => {
    expect(fail(run('<svg role="img" hidden></svg>'))).toBeDefined();
  });

  test("an svg a style may hide but squirrel cannot settle is unconfirmed, not a failure", () => {
    const checks = run('<div class="promo"><svg role="img"></svg></div>', "<style>.promo:hover{display:none}</style>");
    expect(fail(checks)).toBeUndefined();
    expect(checks.find((c) => c.name === "svg-img-alt-unconfirmed")?.status).toBe("warn");
  });
});

describe("counting", () => {
  test("each failing svg is counted once, with a pass-only page unaffected", () => {
    const checks = run(
      '<svg role="img"></svg><svg role="img" aria-label="ok"></svg><svg role="img"></svg><svg role="img"><title>named</title></svg>',
    );
    const f = fail(checks);
    expect(f?.value).toBe(2);
    expect(f?.items).toHaveLength(2);
    expect(f?.message).toBe('2 <svg role="img"> element(s) without an accessible name');
  });

  test("a clickable unnamed svg that a11y/aria-labels already reports is not reported twice", () => {
    expect(nothing(run('<svg role="img" onclick="go()"></svg>'))).toBe(true);
    expect(nothing(run('<svg role="img" tabindex="0"></svg>'))).toBe(true);
  });

  test("a clickable svg that aria-labels accepts but this rule does not is still reported", () => {
    // aria-labels is satisfied by any <title>, even an empty one; this rule needs text.
    expect(fail(run('<svg role="img" onclick="go()"><title></title></svg>'))).toBeDefined();
  });

  test("more than ten failures list ten and count the rest", () => {
    const f = fail(run('<svg role="img"></svg>'.repeat(13)));
    expect(f?.items).toHaveLength(10);
    expect(f?.details).toEqual({ additional: 3 });
  });

  test("a page with no svg emits nothing", () => {
    expect(nothing(run("<p>text</p>"))).toBe(true);
  });
});
