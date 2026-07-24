// perf/unminified-js — Vite/esbuild bundles legitimately preserve `/*! ... */`
// license banners even when fully minified (#698). Live FP: a 483KB fully
// minified production bundle was flagged "appears unminified" purely because
// it carried 4 preserved license comments. Banners must be stripped before
// the minification heuristic runs, without masking genuinely unminified code.

import { describe, expect, test } from "bun:test";

import type { ScriptContentData } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { unminifiedJsRule } from "../src/performance/unminified-js";
import type { RuleContext } from "../src/types";

function ctx(scripts: ScriptContentData[]): RuleContext {
  const url = "https://example.com/";
  const html = "<!DOCTYPE html><html><head><title>t</title></head><body></body></html>";
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      scripts,
    },
    options: {},
  } as unknown as RuleContext;
}

function scriptEntry(url: string, content: string): ScriptContentData {
  return {
    url,
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: content.length,
    content,
    sourcePages: ["https://example.com/"],
  };
}

function checkNamed(checks: ReturnType<typeof unminifiedJsRule.run>["checks"], name: string) {
  return checks.find((c) => c.name === name);
}

// 4 preserved license banners, as esbuild/Vite/Terser emit per bundled dep.
const LICENSE_BANNERS = [
  "/*! foo-lib v1.0.0 | (c) 2024 Foo Inc | MIT License */",
  "/*! bar-lib v2.3.1 | (c) 2023 Bar Co | MIT License */",
  "/*! baz-lib v0.8.0 | (c) 2022 Baz LLC | Apache-2.0 */",
  "/*! qux-lib v1.1.4 | (c) 2021 Qux | MIT License */",
].join("\n");

// Fully minified single-line body: short identifiers, no whitespace/comments.
const MINIFIED_BODY = `(function(){"use strict";var a=1,b=2,c=function(d,e){return d+e};for(var f=0;f<100;f++){c(a,b)}window.__app=c;var g="${"x".repeat(2200)}";})();`;

// Genuinely unminified: long function/variable names, indentation, many newlines.
const UNMINIFIED_BODY = `function outerWrapperFunction() {\n${Array.from(
  { length: 60 },
  (_, i) =>
    `  function processUserRequestNumber${i}(inputArgument) {\n    var localResultValue = inputArgument + ${i};\n    return localResultValue;\n  }`,
).join("\n")}\n}`;

describe("perf/unminified-js — license banner handling", () => {
  test("#698: minified Vite bundle with 4 license banners is NOT flagged", () => {
    const content = `${LICENSE_BANNERS}\n${MINIFIED_BODY}`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-abc123.js", content)]),
    );
    expect(checkNamed(checks, "unminified-js")).toBeUndefined();
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });

  test("review regression: CRLF-terminated //! banners are stripped too", () => {
    const crlfBanners = "//! license line one\r\n//! license line two\r\n/*! bundled-lib v1 */\r\n";
    const { checks } = unminifiedJsRule.run(
      ctx([
        scriptEntry("https://example.com/assets/index-crlf.js", `${crlfBanners}${MINIFIED_BODY}`),
      ]),
    );
    expect(checkNamed(checks, "unminified-js")).toBeUndefined();
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });

  test("baseline: minified bundle with no banner at all still passes", () => {
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-abc123.js", MINIFIED_BODY)]),
    );
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });

  test("true positive preserved: unminified code with NO banner is still flagged", () => {
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/app.js", UNMINIFIED_BODY)]),
    );
    expect(checkNamed(checks, "unminified-js")?.status).toBe("warn");
  });

  test("true positive preserved: unminified code WITH a license banner is still flagged (no masking)", () => {
    const content = `${LICENSE_BANNERS}\n${UNMINIFIED_BODY}`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/app.js", content)]),
    );
    expect(checkNamed(checks, "unminified-js")?.status).toBe("warn");
  });

  test("codex regression: a `/*!`-like sequence MID-FILE is never stripped (only leading banners are), so real code after it isn't swallowed", () => {
    // A minified-looking prefix, then a stray `/*!` deep in the file followed
    // much later by an unrelated `*/`-shaped substring inside otherwise
    // unminified, indented, long-named code. Only leading banners get
    // stripped, so this unminified tail must still be detected.
    const content = `(function(){"use strict";var a=1;/*! not a real banner, mid-file */${UNMINIFIED_BODY}})();`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/app.js", content)]),
    );
    expect(checkNamed(checks, "unminified-js")?.status).toBe("warn");
  });
});
