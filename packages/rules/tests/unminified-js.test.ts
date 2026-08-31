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

// #142: `//` was counted with /\/\/[^\n]*/g, which has no notion of string
// context. Every `"https://..."` in a bundle scored as a comment running to the
// end of the line, and in a minified bundle that is most of the file — hence a
// 330KB already-minified bundle reported as "27 comments, ~295KB savings".

// Six protocol slashes, none of them a comment.
const URLS = [
  "https://github.com/squirrelscan/squirrelscan",
  "https://example.com/api/v1/items",
  "https://cdn.example.com/assets/main.css",
  "https://docs.example.com/guide/getting-started",
  "https://api.example.com/v2/search?q=1",
  "//cdn.example.com/protocol-relative.js",
];

// A minified bundle the way esbuild actually emits one: a few very long lines,
// each carrying a URL. Short identifiers, no whitespace runs, zero comments, and
// a newline ratio (~0.2%) well under NEWLINE_RATIO_THRESHOLD. One URL per line
// matters — the old regex consumed to end of line, so same-line URLs hid behind
// the first match; spread across lines they each scored as a separate comment.
const MINIFIED_WITH_URLS = `${URLS.map(
  (u, i) => `var a${i}=[${JSON.stringify(u)},"${"y".repeat(400)}"];`,
).join("\n")}\nwindow.__u=[a0,a1,a2,a3,a4,a5];`;

describe("perf/unminified-js — string-aware comment detection (#142)", () => {
  test("#142: a minified bundle whose only slashes are URLs in string literals is NOT flagged", () => {
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-DAwQ9g4m.js", MINIFIED_WITH_URLS)]),
    );
    expect(checkNamed(checks, "unminified-js")).toBeUndefined();
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });

  test("#142: savings never include the URL tails when the file is flagged for another reason", () => {
    // The URL-bearing minified lines, then enough short lines to trip the
    // newline ratio. Only the newlines are recoverable; before the fix the six
    // URLs each contributed their ~400-byte line tail to the savings (~2.4KB on
    // a 2.8KB file, the same nonsense as "295KB savings" on a 330KB bundle).
    const padding = Array.from({ length: 20 }, (_, i) => `x${i}=${i};`).join("\n");
    const content = `${MINIFIED_WITH_URLS}\n${padding}`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-newlines.js", content)]),
    );
    const warn = checkNamed(checks, "unminified-js");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toContain("high newlines");
    expect(warn?.items?.[0]?.meta?.reason).not.toContain("comments");
    // 20 newlines is ~0.02KB. The old regex reported thousands of bytes here.
    expect(warn?.details?.totalPotentialSavingsKb).toBe("0.0");
  });

  test("#142: `//` inside a template literal is not a comment", () => {
    // The `${...}` here are fixture text, not interpolations of this test file:
    // the scanner has to re-enter code mode inside a template's interpolation
    // and come back out, without losing the surrounding template context.
    // oxlint-disable no-template-curly-in-string
    const templates = [
      "var b=`see https://example.com/docs and //cdn.example.com/x`;",
      "var c=`${b} https://example.com/one`;",
      "var e=`https://example.com/two ${b} https://example.com/three`;",
      "var f=`https://example.com/four`;",
      "var g=`//cdn.example.com/five`;",
    ];
    // oxlint-enable no-template-curly-in-string
    const content = `${templates
      .map((t, i) => `${t}var p${i}="${"z".repeat(400)}";`)
      .join("\n")}\nwindow.__t=[b,c,e,f,g];`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-template.js", content)]),
    );
    expect(checkNamed(checks, "unminified-js")).toBeUndefined();
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });

  test("true positive preserved: real `//` comments are still counted and flagged", () => {
    // Six genuine line comments over a body that is otherwise minified-looking,
    // so "comments" is the only reason the rule can fire.
    const comments = Array.from({ length: 6 }, (_, i) => `// step ${i}`).join("\n");
    const content = `${comments}\nvar a=1,b="${"q".repeat(2400)}";window.__c=[a,b];`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/app-commented.js", content)]),
    );
    const warn = checkNamed(checks, "unminified-js");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toBe("6 comments");
  });

  test("true positive preserved: a `//` comment after a string on the same line is still counted", () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `var u${i}="https://example.com/page/${i}"; // note ${i}`,
    ).join("\n");
    const content = `${lines}\nvar z="${"w".repeat(2400)}";window.__z=z;`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/app-trailing.js", content)]),
    );
    const warn = checkNamed(checks, "unminified-js");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toContain("6 comments");
  });

  test("a regex literal containing slashes is not read as a comment", () => {
    const patterns = [
      "var a=/https?:\\/\\//;",
      "var b=/[/]/;",
      'var c="x".replace(/\\/\\//g,"");',
      "var d=1/2/1;",
      "var e=/a\\/\\/b/.source;",
    ];
    const content = `${patterns
      .map((p, i) => `${p}var q${i}="${"r".repeat(400)}";`)
      .join("\n")}\nwindow.__r=[a,b,c,d,e];`;
    const { checks } = unminifiedJsRule.run(
      ctx([scriptEntry("https://example.com/assets/index-regex.js", content)]),
    );
    expect(checkNamed(checks, "unminified-js")).toBeUndefined();
    expect(checkNamed(checks, "minified-js")?.status).toBe("pass");
  });
});
