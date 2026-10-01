// a11y/color-contrast — the <style> scan must stay linear in the CSS it reads.
//
// The rule used to pull color-declaring rule blocks out of each <style> with
// LEGACY_RULE_RE below, which is quadratic in the length of a brace-free run: a
// chat widget's 428KB <style> of base64 @font-face data took 76s on one page.
// extractColorRules finds the same matches in linear time; the old regex stays
// here as the oracle for ordinary CSS, where it is fast.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { colorContrastRule, extractColorRules } from "../src/a11y/color-contrast";
import type { RuleContext } from "../src/types";

const LEGACY_RULE_RE = /[^{}]+\{[^{}]*color\s*:[^;]+;[^{}]*\}/gi;

function legacyRules(css: string): string[] {
  return css.match(LEGACY_RULE_RE) ?? [];
}

function ctx(html: string): RuleContext {
  const url = "https://example.com/";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
  } as unknown as RuleContext;
}

function pageWithStyle(css: string): string {
  return `<!DOCTYPE html><html><head><title>t</title><style>${css}</style></head><body><p>Some text</p></body></html>`;
}

/** Seeded generator: same seed, same sequence (no Math.random in tests). */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

/** `len` characters of base64 alphabet, the shape of an embedded font. */
function base64Run(len: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const next = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(alphabet[next(64)]!);
  return out.join("");
}

/** About `bytes` of `@font-face` blocks with base64 `src`, like a chat widget ships. */
function fontFaceCss(bytes: number): string {
  return [0.7, 0.1, 0.1, 0.05, 0.05]
    .map(
      (share, i) =>
        `@font-face{font-family:"Widget${i}";src:url(data:font/woff2;base64,${base64Run(Math.floor(share * bytes), i + 1)}) format("woff2");font-weight:${400 + i * 100};font-style:normal;font-display:swap}`
    )
    .join("\n");
}

const ORDINARY_CSS: Record<string, string> = {
  "one rule": ".muted{color:#ccc;}",
  "spaced and multi-line": ".muted {\n  color: #999;\n  margin: 0;\n}\n.b { padding: 0; }",
  "minified sheet": "body{margin:0;color:#333;font:16px/1.5 sans-serif}a{color:#06c;}a:hover{color:#ddd;text-decoration:underline}.x{display:none}",
  "last declaration without a semicolon": ".a{color:#ccc}.b{margin:0;}",
  "background-color counts as color": ".hero{background-color:#eee;padding:2rem;}",
  "upper case and space before the colon": ".a{COLOR :#aaa;}",
  "nested in @media": "@media (max-width:600px){.x{color:#bbb;}.y{margin:0}}",
  "commented-out declaration": "/* .old{color:#ccc;} */.new{color:#111;}",
  "empty value": ".a{color:;}.b{color:red;}",
  "rgb value": ".a{color:rgb(200, 200, 200);}",
  "font-face before a color rule": "@font-face{font-family:x;src:url(data:font/woff2;base64,d09GMgABAAAAA)}.t{color:#eee;}",
  "unclosed rule": ".a{color:#ccc;",
  "no braces at all": "color:#ccc;",
  "stray braces": "}}{{.a{color:#ccc;}}{",
  empty: "",
};

describe("extractColorRules matches the legacy regex", () => {
  for (const [name, css] of Object.entries(ORDINARY_CSS)) {
    test(name, () => {
      expect(extractColorRules(css)).toEqual(legacyRules(css));
    });
  }

  test("on 20,000 random CSS-like strings", () => {
    const tokens = [
      "a", ".b ", "a{", ".c {", " ", "\n", "{", "}", ";", ":", "{}", "}{", ";;",
      "color", "COLOR", "color :", "color:", "color:#ccc", "background-color: red",
      "#ccc", "rgb(200,", "@media", "(", ")", "x",
    ];
    const next = rng(2378);
    let matched = 0;
    for (let i = 0; i < 20_000; i++) {
      let css = "";
      const len = next(40);
      for (let j = 0; j < len; j++) css += tokens[next(tokens.length)];
      const expected = legacyRules(css);
      matched += expected.length;
      expect(extractColorRules(css)).toEqual(expected);
    }
    // The corpus has to exercise the matching paths, not just the misses.
    expect(matched).toBeGreaterThan(1_000);
  });
});

describe("a11y/color-contrast — findings on ordinary CSS", () => {
  test("a light gray rule in a <style> block is reported", () => {
    const { checks } = colorContrastRule.run(ctx(pageWithStyle(".muted{color:#ccc;}")));
    expect(checks[0]?.status).toBe("warn");
    expect(checks[0]?.items?.map((i) => i.id)).toContain(
      'CSS rule ".muted...": light gray text color'
    );
    expect(checks[0]?.details?.cssIssues).toBe(1);
  });

  test("a rule whose last color declaration has no semicolon is still reported", () => {
    const { checks } = colorContrastRule.run(
      ctx(pageWithStyle(".faint{color:#ddd}.b{margin:0;}"))
    );
    expect(checks[0]?.items?.map((i) => i.id)).toContain(
      'CSS rule ".faint...": light gray text color'
    );
  });

  test("dark text colors produce no CSS findings", () => {
    const { checks } = colorContrastRule.run(
      ctx(pageWithStyle("body{color:#111;}a{color:#003366;}"))
    );
    expect(checks.every((c) => !c.details?.cssIssues)).toBe(true);
  });
});

describe("a11y/color-contrast — linear in the size of the CSS", () => {
  test("a 500KB <style> of base64 @font-face data finishes well under a second", () => {
    const css = `${fontFaceCss(500 * 1024)}\n.muted{color:#ccc;}`;
    expect(css.length).toBeGreaterThan(500 * 1024);
    const page = ctx(pageWithStyle(css));

    const start = performance.now();
    const { checks } = colorContrastRule.run(page);
    const elapsed = performance.now() - start;

    // The legacy regex took over a minute on this block; linear takes a few ms.
    // The bound is generous so a loaded CI runner cannot flake it.
    expect(elapsed).toBeLessThan(500);
    // And the scan still reaches the rule after the fonts.
    expect(checks[0]?.items?.map((i) => i.id)).toContain(
      'CSS rule ".muted...": light gray text color'
    );
  });

  test("a 300KB brace-free run is scanned in linear time", () => {
    const run = base64Run(300 * 1024, 7);
    for (const css of [run, `{${run}}`, `a{${run}`, `.a{color:${run}}`]) {
      const start = performance.now();
      expect(extractColorRules(css)).toEqual([]);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });

  test("many rules whose values all run to the same far semicolon", () => {
    // Every `color:` here has no ";" in its own block, so `[^;]+` runs on to
    // the one ";" at the very end, and each block asks where that is. Without
    // the remembered scan that is one 900KB+ walk per block: seconds.
    const css = (n: number) => `${"a{color:}".repeat(n)}${"x".repeat(n * 9)};{`;
    expect(extractColorRules(css(50))).toEqual(legacyRules(css(50)));

    const start = performance.now();
    expect(extractColorRules(css(100_000))).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("one block with thousands of color declarations", () => {
    const css = (n: number) => `.a{${"color:x ".repeat(n)}}b{;}`;
    expect(extractColorRules(css(50))).toEqual(legacyRules(css(50)));

    const big = css(30_000);
    const start = performance.now();
    expect(extractColorRules(big)).toEqual([big]);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
