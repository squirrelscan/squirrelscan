// perf/critical-request-chains counts only the CSS @imports a browser fetches
// (#725): not one inside a comment, a string or a url(), and not one that comes
// after another rule.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { criticalRequestChainsRule } from "../src/performance/critical-request-chains";
import { findCssImports } from "../src/shared/css-imports";
import type { CheckResult, RuleContext } from "../src/types";

const URL = "https://example.com/";

function makeCtx(style: string): RuleContext {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CSS import control</title><style>${style}</style></head><body>x</body></html>`;
  const parsed = parsePage(html, URL);
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {}, parsed },
    parsed,
    options: {},
  };
}

function run(style: string): CheckResult {
  const { checks } = criticalRequestChainsRule.run(makeCtx(style)) as { checks: CheckResult[] };
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("perf/critical-request-chains @import counting", () => {
  test("the reporter's comment-only page has no import and passes", () => {
    const c = run('/* @import url("/comment-only.css"); */ body { color: black; }');
    expect(c.status).toBe("pass");
    expect(c.message).toBe("No critical request chains detected");
  });

  test("a real @import still counts and warns", () => {
    const c = run('@import url("/real-import.css");');
    expect(c.status).toBe("warn");
    expect(c.details?.importCount).toBe(1);
  });

  test("a style block with no import passes", () => {
    expect(run("body { color: black; }").status).toBe("pass");
  });

  test("an import after comments and whitespace still counts", () => {
    const c = run('\n  /* reset */\n\t@import url("/a.css");');
    expect(c.details?.importCount).toBe(1);
  });

  test("an import inside @media or @supports is in an invalid position and counts 0", () => {
    expect(run('@media screen { @import url("/a.css"); }').status).toBe("pass");
    expect(run('@supports (display: grid) { @import url("/a.css"); }').status).toBe("pass");
  });

  test("a commented import followed by a real one counts once", () => {
    const c = run('/* @import url("/a.css"); */ @import url("/b.css");');
    expect(c.status).toBe("warn");
    expect(c.details?.importCount).toBe(1);
  });
});

describe("findCssImports", () => {
  const urls = (css: string) => findCssImports(css).map((i) => i.url);

  test("text that only contains @import is not an import", () => {
    expect(urls('a::before{content:"@import url(x.css)"}')).toEqual([]);
    expect(urls("body{background:url(/x@import.png)}")).toEqual([]);
    expect(urls("@imports x;")).toEqual([]);
    expect(urls("/* @import url(a.css);")).toEqual([]);
  });

  test("the at-keyword is case-insensitive", () => {
    expect(urls("@IMPORT url(a.css);")).toEqual(["a.css"]);
  });

  test("an @import after another rule is ignored, as a browser does", () => {
    expect(urls("body{} @import url(/late.css);")).toEqual([]);
    expect(urls("@media print { @import url(/nested.css); }")).toEqual([]);
    expect(urls("@font-face{font-family:x} @import url(/late.css);")).toEqual([]);
  });

  test("@charset and @layer statements may come first", () => {
    expect(urls('@charset "utf-8"; @layer a; @import url(a.css);')).toEqual(["a.css"]);
    expect(urls("@layer a { b{} } @import url(a.css);")).toEqual([]);
    // After an import, a @layer statement is a rule like any other.
    expect(urls("@import url(a.css); @layer x; @import url(b.css);")).toEqual(["a.css"]);
  });

  test("an unterminated url( keeps its last character; a string broken by a newline is dropped", () => {
    expect(urls("@import url(https://fonts.googleapis.com")).toEqual([
      "https://fonts.googleapis.com",
    ]);
    expect(urls('@import "a.css\n; @import url(b.css);')).toEqual([]);
  });

  test("reads every URL form and the trailing conditions", () => {
    expect(
      findCssImports(
        `@import "q.css" screen;
         @import 'r.css';
         @import url( s.css ) print;
         @import url("t.css") layer(base) supports(display: grid) not print;
         @import url(https://fonts.googleapis.com/css?family=Roboto:400,700&display=swap);`,
      ),
    ).toEqual([
      { url: "q.css", media: "screen" },
      { url: "r.css", media: "" },
      { url: "s.css", media: "print" },
      { url: "t.css", media: "layer(base) supports(display: grid) not print" },
      { url: "https://fonts.googleapis.com/css?family=Roboto:400,700&display=swap", media: "" },
    ]);
  });

  test("a semicolon inside a string or url() does not end the statement", () => {
    expect(urls('@import "a;b.css"; @import url(c;d.css); @import url(e.css);')).toEqual([
      "a;b.css",
      "c;d.css",
      "e.css",
    ]);
  });

  test("HTML comment markers and comments between imports are skipped", () => {
    expect(urls("<!-- @import url(a.css); /* x */ @import url(b.css); -->")).toEqual([
      "a.css",
      "b.css",
    ]);
  });

  test("an @import with no URL is dropped, as a browser does, and later ones still load", () => {
    expect(urls('@import ; @import url(""); @import url(a.css);')).toEqual(["a.css"]);
  });

  test("scans adversarial input in linear time", () => {
    const started = performance.now();
    findCssImports(`@import url(a.css);${"/*".repeat(50_000)}`);
    findCssImports(`@import "${"\\".repeat(100_000)}`);
    findCssImports(`@import url(${"(".repeat(100_000)}`);
    findCssImports("@import ".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
