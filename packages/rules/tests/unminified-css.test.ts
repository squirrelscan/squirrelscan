// perf/unminified-css — #142 counted `/* ... */` with a plain regex, so a
// comment opener sitting inside a string literal (`content: "..."`, a data URI)
// started a "comment" that ran to the next `*/`. Same shape as the JS rule's
// `//`-in-a-URL bug, so comment counting here is string-aware too.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { unminifiedCssRule } from "../src/performance/unminified-css";
import type { RuleContext } from "../src/types";

function ctx(css: string): RuleContext {
  const url = "https://example.com/";
  const html = `<!DOCTYPE html><html><head><title>t</title><style>${css}</style></head><body></body></html>`;
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null },
    options: {},
  } as unknown as RuleContext;
}

function checkNamed(checks: ReturnType<typeof unminifiedCssRule.run>["checks"], name: string) {
  return checks.find((c) => c.name === name);
}

// Minified filler: one line, no comments, well over min_size_bytes.
const PADDING = Array.from(
  { length: 60 },
  (_, i) => `.p${i}{color:#abcdef;margin:0;padding:0;border:0}`,
).join("");

describe("perf/unminified-css — string-aware comment detection (#142)", () => {
  test("#142: `/* */` inside a string literal is not counted as a comment", () => {
    const strings = Array.from(
      { length: 5 },
      (_, i) => `.s${i}::before{content:"/* not a comment ${i} */"}`,
    ).join("");
    const { checks } = unminifiedCssRule.run(ctx(`${strings}${PADDING}`));
    expect(checkNamed(checks, "unminified-css")).toBeUndefined();
    expect(checkNamed(checks, "minified-css")?.status).toBe("pass");
  });

  test("true positive preserved: real CSS comments are still counted and flagged", () => {
    const comments = Array.from({ length: 5 }, (_, i) => `/* section ${i} */`).join("");
    const { checks } = unminifiedCssRule.run(ctx(`${comments}${PADDING}`));
    const warn = checkNamed(checks, "unminified-css");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toBe("5 comments");
  });

  test("a real comment following a string on the same line is still counted", () => {
    const mixed = Array.from(
      { length: 5 },
      (_, i) => `.m${i}::after{content:"/* x */"}/* real ${i} */`,
    ).join("");
    const { checks } = unminifiedCssRule.run(ctx(`${mixed}${PADDING}`));
    const warn = checkNamed(checks, "unminified-css");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.meta?.reason).toBe("5 comments");
  });
});
