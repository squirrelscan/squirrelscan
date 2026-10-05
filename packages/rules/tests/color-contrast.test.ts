// a11y/color-contrast reports only contrast it measured (#465).
//
// The rule used to warn on class names (`text-gray-300`), on light colors in
// <style> blocks and on raw `color:` text in the HTML, none of which says what
// the text sits on: `text-gray-300` on a near-black hero is above 12:1. Now an
// element is reported only when its text color and an opaque background are
// both set inline and the computed ratio is under 4.5:1. A pair it cannot
// resolve is not a violation (axe calls it "incomplete").
//
// It must also stay linear in what it reads: the <style> scan it no longer has
// once took 76s on a 428KB block of base64 fonts (#2378).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { colorContrastRule } from "../src/a11y/color-contrast";
import type { CheckResult, RuleContext } from "../src/types";

function ctx(html: string): RuleContext {
  const url = "https://example.com/";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function page({ head = "", body = "" }: { head?: string; body?: string }): string {
  return `<!DOCTYPE html><html lang="en"><head><title>t</title>${head}</head><body><main><h1>Page</h1>${body}</main></body></html>`;
}

function run(html: string): CheckResult {
  return runCtx(ctx(html));
}

function runCtx(context: RuleContext): CheckResult {
  const result = colorContrastRule.run(context);
  if (result instanceof Promise) throw new Error("color-contrast is async");
  expect(result.checks).toHaveLength(1);
  return result.checks[0]!;
}

/** Milliseconds the rule itself takes, parsing excluded. */
function timeRule(html: string): number {
  const context = ctx(html);
  const start = performance.now();
  runCtx(context);
  return performance.now() - start;
}

describe("guesses are not reported", () => {
  test("the #465 repro: text-gray-300 on a dark background from an external stylesheet", () => {
    const check = run(
      page({
        head: `<link rel="stylesheet" href="s.css">`,
        body: `<section class="hero"><p class="text-gray-300">Gray 300 text on a near-black background</p></section>`,
      })
    );
    expect(check.status).toBe("pass");
    expect(check.items).toBeUndefined();
  });

  test.each([
    ["Tailwind gray utility", `<p class="text-gray-400">x</p>`],
    ["Bootstrap muted", `<p class="text-muted">x</p>`],
    ["opacity utility", `<p class="opacity-30">x</p>`],
    ["light color in a <style> block", `<style>.muted{color:#ccc;}</style><p class="muted">x</p>`],
    ["white text in a <style> block", `<style>h2{color:#fff}</style><h2>x</h2>`],
    ["light text color alone, inline", `<p style="color:#ddd">x</p>`],
    ["background alone, inline", `<p style="background:#fff">x</p>`],
  ])("%s", (_label, body) => {
    const check = run(page({ body }));
    expect(check.status).not.toBe("warn");
    expect(check.items).toBeUndefined();
  });
});

describe("measured pairs below 4.5:1 are reported", () => {
  test("gray on white, both inline", () => {
    const check = run(page({ body: `<span style="color:#999;background:#fff">Low</span>` }));
    expect(check.status).toBe("warn");
    expect(check.message).toBe("1 color contrast issue(s) below 4.5:1");
    expect(check.items).toEqual([{ id: "span: #999 on #fff (2.85:1)" }]);
    expect(check.details?.measuredPairs).toBe(1);
  });

  test.each([
    ["named colors", "color: silver; background-color: white", "p: silver on white (1.82:1)"],
    ["rgb()", "color: rgb(150, 150, 150); background: rgb(255,255,255)", "p: rgb(150, 150, 150) on rgb(255,255,255) (2.96:1)"],
    ["opaque rgba()", "color: rgba(150,150,150,1); background: #fff", "p: rgba(150,150,150,1) on #fff (2.96:1)"],
    ["opaque 8-digit hex", "color: #999999ff; background: #ffffff", "p: #999999ff on #ffffff (2.85:1)"],
    ["!important", "color: #999 !important; background: #fff", "p: #999 on #fff (2.85:1)"],
    ["! important with a space", "color: #999 ! important; background: #fff", "p: #999 on #fff (2.85:1)"],
    ["the last declaration wins", "color:#111;color:#ccc;background:#000;background:#fff", "p: #ccc on #fff (1.61:1)"],
    ["!important beats a later declaration", "color:#ccc !important;color:#111;background:#fff", "p: #ccc on #fff (1.61:1)"],
    ["an unrelated url() elsewhere in the style", "color:#ccc;background:#fff;cursor:url(x.cur),auto", "p: #ccc on #fff (1.61:1)"],
    ["background-image: none", "color:#ccc;background-color:#fff;background-image:none", "p: #ccc on #fff (1.61:1)"],
    ["a one-color shorthand after an image", "color:#ccc;background-image:url(x.png);background:#fff", "p: #ccc on #fff (1.61:1)"],
  ])("%s", (_label, style, id) => {
    const check = run(page({ body: `<p style="${style}">Text</p>` }));
    expect(check.items).toEqual([{ id }]);
  });

  test.each([
    ["a quoted string", `color:#111;background:#fff;--note:';color:#ccc;'`],
    ["a comment", "color:#111;background:#fff/*;color:#ccc;*/"],
    ["parentheses", "color:#111;background:#fff;--x:calc(1px;color:#ccc)"],
  ])("a ; inside %s does not end a declaration", (_label, style) => {
    const check = run(page({ body: `<p style="${style}">Dark</p>` }));
    expect(check.status).toBe("pass");
    expect(check.details?.measuredPairs).toBe(1);
  });

  test("a superseded low-contrast color is not reported", () => {
    const check = run(page({ body: `<p style="color:#ccc;color:#111;background:#fff">Dark</p>` }));
    expect(check.status).toBe("pass");
    expect(check.details?.measuredPairs).toBe(1);
  });

  test("a passing pair is measured and passes", () => {
    const check = run(page({ body: `<p style="color:#111;background:#fff">Dark</p>` }));
    expect(check.status).toBe("pass");
    expect(check.details?.measuredPairs).toBe(1);
  });
});

describe("pairs that cannot be resolved from the markup are not reported", () => {
  test.each([
    ["transparent background", "color:#ccc;background:transparent"],
    ["semi-transparent rgba text", "color:rgba(0,0,0,.2);background:#fff"],
    ["semi-transparent rgba background", "color:#ccc;background-color:rgba(255,255,255,0.5)"],
    ["alpha as a percentage", "color:#ccc;background:rgba(255,255,255,50%)"],
    ["semi-transparent 8-digit hex", "color:#cccccc80;background:#fff"],
    ["semi-transparent 4-digit hex", "color:#ccc8;background:#fff"],
    ["background image", "color:#ccc;background:#fff url(hero.jpg)"],
    ["background shorthand beyond one color", "color:#ccc;background:#fff no-repeat"],
    ["image-set() in the shorthand", `color:#ccc;background:#fff image-set('x.png' 1x)`],
    ["an image shorthand under a later background-color", "color:#ccc;background:url(x.png);background-color:#fff"],
    ["a later unresolvable background", "color:#ccc;background:#fff;background:var(--surface)"],
    ["trailing junk after !important", "color:#ccc;background:#fff !important junk"],
    ["over-long hex", "color:#ccc;background-color:#ffffffff0"],
    ["a color split by a comment", "color:#111;color:#c/**/cc;background:#fff"],
    ["gradient", "color:#ccc;background:linear-gradient(#fff, #eee)"],
    ["separate background-image", "color:#ccc;background-color:#fff;background-image:url(x.png)"],
    ["inherit", "color:inherit;background:#fff"],
    ["currentcolor", "color:#ccc;background:currentcolor"],
    ["a name that is an Object property", "color:constructor;background:#fff"],
    ["malformed hex", "color:#99;background:#fff"],
    ["out-of-range rgb", "color:rgb(300,300,300);background:#fff"],
  ])("%s", (_label, style) => {
    const check = run(page({ body: `<p style="${style}">Text</p>` }));
    expect(check.status).toBe("pass");
    expect(check.details?.measuredPairs).toBe(0);
  });

  test("an element with no text has nothing to contrast", () => {
    const check = run(page({ body: `<div style="color:#eee;background:#fff"></div>` }));
    expect(check.status).toBe("pass");
  });
});

describe("output when there is nothing to measure", () => {
  test("a page with no styled or classed elements returns info", () => {
    const result = colorContrastRule.run(
      ctx(`<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>`)
    );
    if (result instanceof Promise) throw new Error("async");
    expect(result.checks[0]?.status).toBe("info");
  });
});

describe("linear in what it reads", () => {
  test("a 500KB <style> of base64 font data costs nothing", () => {
    const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".repeat(8000);
    const html = page({
      head: `<style>@font-face{font-family:W;src:url(data:font/woff2;base64,${base64}) format("woff2")}.muted{color:#ccc;}</style>`,
    });
    expect(timeRule(html)).toBeLessThan(500);
  });

  test.each([
    ["a long alpha value", (n: number) => `color:rgba(1,2,3,${"1".repeat(n)}x;background:#fff`],
    ["a long whitespace run after color", (n: number) => `color${" ".repeat(n)}x;background:#fff`],
    ["many empty declarations", (n: number) => `${";".repeat(n)}color:#999;background:#fff`],
    ["many unclosed comments", (n: number) => `color:#999;background:#fff${"/*".repeat(n / 2)}`],
    ["many open parentheses", (n: number) => `color:#999;background:#fff;--x:${"(".repeat(n)}`],
    ["many quotes", (n: number) => `color:#999;background:#fff;--x:${"'".repeat(n)}`],
  ])("an inline style with %s", (_label, style) => {
    // 200KB: the quadratic form of the alpha pattern takes seconds here.
    expect(timeRule(page({ body: `<p style="${style(200_000)}">Text</p>` }))).toBeLessThan(500);
  });
});
