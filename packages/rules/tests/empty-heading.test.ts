// a11y/empty-heading skips headings that are not rendered and labels the rest (#485).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { emptyHeadingRule } from "../src/a11y/empty-heading";
import type { CheckResult, RuleContext } from "../src/types";

function run(body: string): CheckResult | undefined {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hidden headings</title></head><body>${body}</body></html>`;
  const url = "https://example.com/";
  const ctx = {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
  const result = emptyHeadingRule.run(ctx);
  if (result instanceof Promise) throw new Error("empty-heading is async");
  return result.checks.find((c) => c.name === "empty-heading");
}

describe("a11y/empty-heading hidden headings", () => {
  test("the reporter's repro page passes", () => {
    const result = run(`<h1>Shop</h1>
<h2 hidden></h2>
<h2 style="display:none"></h2>`);
    expect(result?.status).toBe("pass");
    expect(result?.items).toBeUndefined();
  });

  test.each([
    ["hidden attribute", `<h1>Shop</h1><h2 hidden></h2>`],
    ["hidden ancestor", `<h1>Shop</h1><div hidden><h2></h2></div>`],
    ["hidden=\"\" ancestor", `<h1>Shop</h1><div hidden=""><section><h2></h2></section></div>`],
    ["inline display:none", `<h1>Shop</h1><h2 style="display:none"></h2>`],
    ["inline display: none !important", `<h1>Shop</h1><h2 style="color:red; display: none !important"></h2>`],
    ["inline visibility:hidden", `<h1>Shop</h1><h2 style="visibility:hidden"></h2>`],
    ["display:none ancestor", `<h1>Shop</h1><div style="display:none"><h2></h2></div>`],
    ["visibility:hidden ancestor", `<h1>Shop</h1><div style="visibility:hidden"><h2></h2></div>`],
    ["style comment before display:none", `<h1>Shop</h1><h2 style="/* x */display:none"></h2>`],
    ["aria-hidden heading", `<h1>Shop</h1><h2 aria-hidden="true"></h2>`],
    ["aria-hidden ancestor", `<h1>Shop</h1><div aria-hidden="true"><h2></h2></div>`],
  ])("%s: passes", (_label, body) => {
    const result = run(body);
    expect(result?.status).toBe("pass");
    expect(result?.items).toBeUndefined();
  });

  test.each([
    ["hidden=\"until-found\" heading", `<h1>Shop</h1><h2 hidden="until-found"></h2>`],
    ["hidden=\"until-found\" ancestor", `<h1>Shop</h1><div hidden="until-found"><h2></h2></div>`],
  ])("%s: warns", (_label, body) => {
    const result = run(body);
    expect(result?.status).toBe("warn");
    expect(result?.items).toHaveLength(1);
  });

  test("a heading that overrides an inherited visibility:hidden is rendered: warns", () => {
    const result = run(
      `<h1>Shop</h1><div style="visibility:hidden"><h2 style="visibility:visible"></h2></div>`,
    );
    expect(result?.status).toBe("warn");
  });

  test("a later display declaration wins over an earlier display:none: warns", () => {
    const result = run(`<h1>Shop</h1><h2 style="display:none;display:block"></h2>`);
    expect(result?.status).toBe("warn");
  });

  test("a page whose only headings are hidden still passes", () => {
    const result = run(`<h2 hidden></h2>`);
    expect(result?.status).toBe("pass");
  });

  test("the position label counts rendered headings only", () => {
    const result = run(`<h2 hidden></h2><h2 hidden></h2><h1>Shop</h1><h2></h2>`);
    expect(result?.items?.[0]?.label).toBe("h2, heading 2 of 2 on the page");
  });

  test("a CSS class that hides a heading cannot be seen from the markup: warns", () => {
    const result = run(`<h1>Shop</h1><h2 class="visually-gone"></h2>`);
    expect(result?.status).toBe("warn");
  });

  test("a visible empty heading warns and the item has a snippet", () => {
    const result = run(`<h1>Shop</h1><h2></h2>`);
    expect(result?.status).toBe("warn");
    expect(result?.message).toBe("1 empty heading(s) found");
    expect(result?.items?.[0]?.snippet).toBe("<h2>");
  });

  test("items tell sibling headings of the same level apart", () => {
    const result = run(`<h1>Shop</h1><h2></h2><h2>Real</h2><h2 data-slot="b"></h2>`);
    expect(result?.items).toHaveLength(2);
    const [first, second] = result?.items ?? [];
    expect(first?.label).not.toBe(second?.label);
    expect(first?.snippet).not.toBe(second?.snippet);
    expect(second?.snippet).toBe('<h2 data-slot="b">');
  });

  test("a hidden empty heading next to a visible empty one reports only the visible one", () => {
    const result = run(`<h1>Shop</h1><h2 hidden></h2><h2 id="promo"></h2>`);
    expect(result?.items).toHaveLength(1);
    expect(result?.items?.[0]?.id).toBe("h2#promo");
  });

  test("a heading whose only content is an image with alt text passes", () => {
    const result = run(`<h1>Shop</h1><h2><img src="/logo.svg" alt="Northwind Traders"></h2>`);
    expect(result?.status).toBe("pass");
  });
});
