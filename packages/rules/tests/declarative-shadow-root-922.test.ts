// #922: controls inside a declarative shadow root (<template shadowrootmode>) are
// rendered by a browser, so every DOM rule must see them; a plain <template> stays inert.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";

import { buttonNameRule } from "../src/a11y/button-name";
import type { ParsedPage, RuleContext } from "../src/types";

const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;

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
});
