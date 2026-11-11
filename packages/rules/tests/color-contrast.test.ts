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

import { colorContrastRule, stylesheetBackgroundOf, stylesheetBackgroundSelectorsOf } from "../src/a11y/color-contrast";
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

function runAll(context: RuleContext): CheckResult[] {
  const result = colorContrastRule.run(context);
  if (result instanceof Promise) throw new Error("color-contrast is async");
  return result.checks;
}

/** The `color-contrast` check, which every page gets exactly once. */
function runCtx(context: RuleContext): CheckResult {
  const found = runAll(context).filter((c) => c.name === "color-contrast");
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The info check that counts inline-colored text the rule could not measure, or undefined. */
function unresolvedOf(html: string): CheckResult | undefined {
  return runAll(ctx(html)).find((c) => c.name === "color-contrast-unresolved");
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
  test("a page with no inline text color passes with a note and emits no info", () => {
    const checks = runAll(
      ctx(`<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>`)
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([["color-contrast", "pass"]]);
    expect(checks[0]!.message).toBe("No obvious contrast issues detected");
    expect(checks[0]!.details?.measuredPairs).toBe(0);
    expect(checks[0]!.details?.note).toContain("No inline text colors to measure");
  });
});

describe("inline color against the computed background (#1752)", () => {
  test("the demo tagline: #b9b9b9 on the browser's white is reported with colors and ratio", () => {
    const check = run(page({ body: `<p style="color:#b9b9b9">Tagline</p>` }));
    expect(check.status).toBe("warn");
    expect(check.items).toEqual([{ id: "p: #b9b9b9 on white (1.96:1)" }]);
    expect(check.details?.measuredPairs).toBe(1);
  });

  test("an inline background on an ancestor is the background", () => {
    const check = run(
      page({ body: `<section style="background:#fff"><div><p style="color:#b9b9b9">x</p></div></section>` })
    );
    expect(check.items).toEqual([{ id: "p: #b9b9b9 on #fff (1.96:1)" }]);
  });

  test("a dark ancestor makes light text pass", () => {
    const check = run(
      page({ body: `<div style="background-color:#000"><p style="color:#b9b9b9">x</p></div>` })
    );
    expect(check.status).toBe("pass");
    expect(check.details?.measuredPairs).toBe(1);
    expect(unresolvedOf(page({ body: `<div style="background-color:#000"><p style="color:#b9b9b9">x</p></div>` }))).toBeUndefined();
  });

  test("the nearest ancestor background wins", () => {
    const check = run(
      page({
        body: `<div style="background:#000"><div style="background:#fff"><p style="color:#b9b9b9">x</p></div></div>`,
      })
    );
    expect(check.items).toEqual([{ id: "p: #b9b9b9 on #fff (1.96:1)" }]);
  });

  test.each([
    ["a gradient", `<div style="background:linear-gradient(#000,#111)"><p style="color:#b9b9b9">x</p></div>`],
    ["a background image", `<div style="background-image:url(x.png)"><p style="color:#b9b9b9">x</p></div>`],
    ["a translucent ancestor", `<div style="background:rgba(0,0,0,.5)"><p style="color:#b9b9b9">x</p></div>`],
    ["a bgcolor attribute", `<table bgcolor="#000"><tr><td><p style="color:#b9b9b9">x</p></td></tr></table>`],
  ])("%s ancestor leaves the pair unresolved, not warned", (_label, body) => {
    const html = page({ body });
    expect(run(html).status).toBe("pass");
    const info = unresolvedOf(html)!;
    expect(info.status).toBe("info");
    expect(info.details?.inconclusive).toBe(true);
    expect(info.details?.unresolved).toBe(1);
  });

  test("a plain body rule in a style block is the background", () => {
    const light = page({
      head: `<style>body { background: #fff; margin: 0 }</style>`,
      body: `<p style="color:#b9b9b9">x</p>`,
    });
    expect(run(light).items).toEqual([{ id: "p: #b9b9b9 on #fff (1.96:1)" }]);
    const dark = page({
      head: `<style>html { background-color: #111 } body{color:#fff}</style>`,
      body: `<p style="color:#b9b9b9">x</p>`,
    });
    expect(run(dark).status).toBe("pass");
    expect(unresolvedOf(dark)).toBeUndefined();
  });

  test.each([
    ["a body gradient", `<style>body{background:linear-gradient(#fff,#eee)}</style>`],
    ["a class rule that sets a background", `<style>.hero{background:#000}</style>`],
    ["a background inside @media", `<style>@media (min-width:1px){body{background:#000}}</style>`],
    ["a linked stylesheet", `<link rel="stylesheet" href="/site.css">`],
    ["an @import", `<style>@import url(/site.css);</style>`],
    [
      "a body rule beside a linked stylesheet that may override it",
      `<style>body{background:#fff}</style><link rel="stylesheet" href="/site.css">`,
    ],
    [
      "a body rule beside a class rule that sets another background",
      `<style>body{background:#fff}.hero{background:#000}</style>`,
    ],
  ])("%s: unresolved, counted with the ratio against white, not warned", (_label, head) => {
    const html = page({ head, body: `<p style="color:#b9b9b9">Tagline</p>` });
    expect(run(html).status).toBe("pass");
    expect(run(html).details?.measuredPairs).toBe(0);
    const info = unresolvedOf(html)!;
    expect(info.status).toBe("info");
    expect(info.details?.inconclusive).toBe(true);
    expect(info.message).toContain("1 inline-colored text element(s) could not be measured");
    expect(info.items).toEqual([{ id: expect.stringContaining("p: #b9b9b9 (1.96:1 against white)") }]);
  });

  test("a stylesheet-set background is named in the message", () => {
    const info = unresolvedOf(
      page({ head: `<link rel="stylesheet" href="/s.css">`, body: `<p style="color:#b9b9b9">x</p>` })
    )!;
    expect(info.message).toBe(
      "1 inline-colored text element(s) could not be measured: the background is set by a stylesheet the audit does not read"
    );
    expect(info.details?.reasons).toEqual({ stylesheet: 1 });
  });

  test("a style block with no background keeps the white default", () => {
    const check = run(
      page({ head: `<style>.muted{color:#ccc}</style>`, body: `<p style="color:#b9b9b9">x</p>` })
    );
    expect(check.status).toBe("warn");
  });

  test("a stylesheet inside <noscript> does not load, so the default holds", () => {
    const check = run(
      page({
        head: `<noscript><link rel="stylesheet" href="/s.css"></noscript>`,
        body: `<p style="color:#b9b9b9">x</p>`,
      })
    );
    expect(check.status).toBe("warn");
  });

  test("a measured warning and unresolved text both appear on one page", () => {
    const checks = runAll(
      ctx(
        page({
          body: `<p style="color:#b9b9b9">low</p><div style="background:url(x.png)"><p style="color:#eee">y</p></div>`,
        })
      )
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["color-contrast", "warn"],
      ["color-contrast-unresolved", "info"],
    ]);
  });

  test("css-wide keywords are not counted as unresolved colors", () => {
    expect(unresolvedOf(page({ body: `<p style="color:inherit">x</p>` }))).toBeUndefined();
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

describe("a linked stylesheet's other background selectors guard the pair (#1756)", () => {
  const sheet = (extra: Record<string, unknown>) => ({
    url: "https://example.com/styles.css",
    status: 200,
    error: null,
    background: { kind: "color", value: "#fff" },
    ...extra,
  });
  const run = (body: string, extra: Record<string, unknown>) =>
    colorContrastRule.run({
      ...ctx(page({ head: '<link rel="stylesheet" href="/styles.css">', body })),
      site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, stylesheetBackgrounds: [sheet(extra)] },
    } as unknown as RuleContext).checks as CheckResult[];
  const TEXT = '<p style="color:#b9b9b9">Tagline</p>';

  test("text inside an element matching a selector with a background is unresolved, by class, id and tag", () => {
    for (const [selector, wrapped] of [
      [".hero", `<div class="hero">${TEXT}</div>`],
      ["#top", `<header id="top"><div>${TEXT}</div></header>`],
      ["footer", `<footer>${TEXT}</footer>`],
    ] as const) {
      const checks = run(wrapped, { selectors: [selector] });
      expect(checks.some((c) => c.status === "warn"), selector).toBe(false);
      expect(checks.some((c) => c.name === "color-contrast-unresolved"), selector).toBe(true);
    }
  });

  test("text outside every matching element is still measured; a truncated list guards everything", () => {
    expect(run(TEXT, { selectors: [".hero"] }).some((c) => c.status === "warn")).toBe(true);
    expect(run(TEXT, { selectors: [".hero"], selectorsTruncated: true }).some((c) => c.status === "warn")).toBe(false);
  });

  test("a selector the DOM cannot evaluate is not provable, so the pair is unresolved", () => {
    expect(run(TEXT, { selectors: ["div:not("] }).some((c) => c.status === "warn")).toBe(false);
  });
});

describe("stylesheetBackgroundSelectorsOf lists the other background selectors (#1756)", () => {
  test("html/body are excluded; at-rules and the cap are reported", () => {
    expect(stylesheetBackgroundSelectorsOf("body{background:#fff}.hero,.card{background:#111}p{color:red}")).toEqual({
      selectors: [".hero", ".card"],
      truncated: false,
    });
    expect(stylesheetBackgroundSelectorsOf("@media (max-width:600px){.nav{background:#000}}").selectors).toEqual([".nav"]);
    const many = Array.from({ length: 205 }, (_, i) => `.c${i}{background:#000}`).join("");
    const r = stylesheetBackgroundSelectorsOf(many);
    expect(r.selectors).toHaveLength(200);
    expect(r.truncated).toBe(true);
  });
});

describe("stylesheetBackgroundOf keeps only the html/body background (#1756)", () => {
  test.each([
    ["a body color", "body{margin:0;background:#101010}", { kind: "color", value: "#101010" }],
    ["body over html", "html{background:#fff}body{background-color:#000}", { kind: "color", value: "#000" }],
    ["a :root color", ":root{background:navy}", { kind: "color", value: "navy" }],
    ["another selector is not read", ".hero{background:#000}p{color:red}", { kind: "none" }],
    ["a gradient on body", "body{background:linear-gradient(#000,#111)}", { kind: "unresolved" }],
    ["a variable", "body{background:var(--bg)}", { kind: "unresolved" }],
    ["an import", '@import url("a.css");body{background:#fff}', { kind: "unresolved" }],
    [
      "a media override of the body",
      "body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000}}",
      { kind: "unresolved" },
    ],
    ["a media rule for another selector", "@media (max-width:600px){.nav{background:#000}}body{background:#fff}", { kind: "color", value: "#fff" }],
  ])("%s", (_label, css, expected) => {
    expect(stylesheetBackgroundOf(css)).toEqual(expected as never);
  });

  test("a linked stylesheet with no read result stays unresolved, one with a read color is measured", () => {
    const html = page({
      head: '<link rel="stylesheet" href="/styles.css">',
      body: '<p style="color:#b9b9b9">Tagline</p>',
    });
    const base = ctx(html);
    const none = colorContrastRule.run(base).checks;
    expect(none.some((c) => c.name === "color-contrast-unresolved")).toBe(true);
    const read = colorContrastRule.run({
      ...base,
      site: {
        baseUrl: "https://example.com",
        pages: [],
        robotsTxt: null,
        sitemaps: null,
        stylesheetBackgrounds: [
          { url: "https://example.com/styles.css", status: 200, error: null, background: { kind: "color", value: "#fff" } },
        ],
      },
    } as unknown as RuleContext).checks as CheckResult[];
    expect(read.find((c) => c.status === "warn")?.items?.[0]?.id).toContain("#b9b9b9 on #fff");
  });
});
