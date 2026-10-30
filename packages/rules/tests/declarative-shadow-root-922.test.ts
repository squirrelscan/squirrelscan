// #922: controls inside a declarative shadow root (<template shadowrootmode>) are
// rendered by a browser, so every DOM rule must see them; a plain <template> stays inert.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { buttonNameRule } from "../src/a11y/button-name";
import { duplicateIdActiveRule } from "../src/a11y/duplicate-id-active";
import { formLabelsRule } from "../src/a11y/form-labels";
import type { ParsedPage, RuleContext } from "../src/types";

const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;

function runRule(rule: { run(ctx: RuleContext): { checks: unknown[] } }, html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {} }, parsed: parsePage(html, url) as ParsedPage, options: {} } as RuleContext;
  return rule.run(ctx).checks as CheckResult[];
}

function buttonName(html: string): CheckResult[] {
  const url = "https://example.com/";
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {} }, parsed: parsePage(html, url) as ParsedPage, options: {} } as RuleContext;
  return buttonNameRule.run(ctx).checks as CheckResult[];
}

describe("declarative shadow roots (#922)", () => {
  for (const mode of ["open", "closed"]) {
    test(`an unnamed button inside shadowrootmode=${mode} is reported like one in the light DOM`, () => {
      const shadow = buttonName(page(`<div><template shadowrootmode="${mode}"><button></button></template></div>`));
      const light = buttonName(page(`<div><button></button></div>`));
      expect(shadow.map((c) => [c.name, c.status])).toEqual(light.map((c) => [c.name, c.status]));
      expect(shadow.some((c) => c.status === "fail")).toBe(true);
    });
  }

  test("a plain <template> is inert: its content is not checked", () => {
    const checks = buttonName(page(`<div><template><button></button></template></div>`));
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  test("a named button inside a shadow root passes", () => {
    const checks = buttonName(page(`<div><template shadowrootmode="open"><button>Buy</button></template></div>`));
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  test("links, images and headings inside shadow roots are reachable by every rule, nested roots included", () => {
    const { document } = parseHTML(
      page(`<my-card><template shadowrootmode="open"><h2>Title</h2><a href="/x">x</a><img src="/i.png"><div><template shadowrootmode="open"><a href="/y">y</a></template></div></template></my-card>`),
    );
    expect(document.querySelectorAll("h2, a, img")).toHaveLength(4);
    expect(document.querySelectorAll("template")).toHaveLength(0);
  });

  test("only the first shadow template of a host counts, and an element that cannot host one stays inert", () => {
    const two = parseHTML(page(`<div><template shadowrootmode="open"><button></button></template><template shadowrootmode="open"><button></button></template></div>`)).document;
    expect(two.querySelectorAll("button")).toHaveLength(1);
    const table = parseHTML(page(`<table><template shadowrootmode="open"><button></button></template></table>`)).document;
    expect(table.querySelectorAll("button")).toHaveLength(0);
  });

  test("a hostile page with thousands of templates is bounded", () => {
    const body = `<div>${Array.from({ length: 20_000 }, () => `<div><template shadowrootmode="open"><b>x</b></template></div>`).join("")}</div>`;
    const started = performance.now();
    parseHTML(page(body));
    expect(performance.now() - started).toBeLessThan(5000);
  });

  const card = `<my-card><template shadowrootmode="open"><label for="q">Search</label><input id="q"><button id="go">Go</button></template></my-card>`;

  test("ids are scoped per root: three identical components are not duplicate ids", () => {
    const checks = runRule(duplicateIdActiveRule, page(card.repeat(3)));
    expect(checks.some((c) => c.status === "fail" || c.status === "warn")).toBe(false);
  });

  test("a real duplicate inside ONE root is still reported, and the light DOM is unaffected", () => {
    const dup = `<my-card><template shadowrootmode="open"><input id="q"><button id="q">Go</button></template></my-card>`;
    expect(runRule(duplicateIdActiveRule, page(dup)).some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
    const light = `<div><input id="a"><button id="a">x</button></div>`;
    expect(runRule(duplicateIdActiveRule, page(light)).some((c) => c.status === "fail" || c.status === "warn")).toBe(true);
  });

  test("label for and aria-labelledby resolve inside their own root only", () => {
    // each root labels its own input: no unlabeled input anywhere
    expect(runRule(formLabelsRule, page(card.repeat(3))).some((c) => c.status === "fail")).toBe(false);
    // a label in root A does not label the input of root B (same id, different roots)
    const split = `<my-a><template shadowrootmode="open"><label for="q">Search</label></template></my-a><my-b><template shadowrootmode="open"><input id="q"></template></my-b>`;
    expect(runRule(formLabelsRule, page(split)).some((c) => c.status === "fail")).toBe(true);
    const aria = `<my-a><template shadowrootmode="open"><span id="t">Name</span></template></my-a><my-b><template shadowrootmode="open"><input aria-labelledby="t"></template></my-b>`;
    const doc = parseHTML(page(aria)).document;
    expect(doc.querySelector("input")!.getAttribute("aria-labelledby")).toBe("t");
  });

  test("slot fallback is dropped only where the host supplies content for the slot", () => {
    const supplied = `<my-x><template shadowrootmode="open"><slot><button></button></slot></template><span>light</span></my-x>`;
    expect(parseHTML(page(supplied)).document.querySelectorAll("button")).toHaveLength(0);
    const named = `<my-x><template shadowrootmode="open"><slot name="a"><button></button></slot><slot><i>fallback</i></slot></template><b slot="a">x</b></my-x>`;
    const nd = parseHTML(page(named)).document;
    expect(nd.querySelectorAll("button")).toHaveLength(0);
    expect(nd.querySelectorAll("i")).toHaveLength(1);
    const empty = `<my-x><template shadowrootmode="open"><slot><button></button></slot></template></my-x>`;
    expect(parseHTML(page(empty)).document.querySelectorAll("button")).toHaveLength(1);
  });

  test("skipped templates do not spend the budget, and deep chains and big pages are documented-bounded", () => {
    const inert = Array.from({ length: 4990 }, () => `<li><template shadowrootmode="open"><b>x</b></template></li>`).join("");
    const chain = `<my-a><template shadowrootmode="open"><my-b><template shadowrootmode="open"><my-c><template shadowrootmode="open"><button></button></template></my-c></template></my-b></template></my-a>`;
    expect(parseHTML(page(`<ul>${inert}</ul>${chain}`)).document.querySelectorAll("button")).toHaveLength(1);
    const comps = Array.from({ length: 3000 }, () => `<my-a><template shadowrootmode="open"><my-b><template shadowrootmode="open"><i></i></template></my-b></template></my-a>`).join("");
    const out = parseHTML(page(comps)).document;
    // 5000 roots are inlined of the 6000 present, then the rest stay inert
    expect(out.querySelectorAll("my-b")).toHaveLength(3000);
    expect(out.querySelectorAll("i")).toHaveLength(2000);
    expect(out.querySelectorAll("template").length).toBe(1000);
  });
});
