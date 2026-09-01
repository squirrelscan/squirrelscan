// Content rules must NOT mutate the shared parsed DOM.
//
// `ctx.parsed.document` is shared across every rule for a page. Before #114,
// keyword-stuffing & reading-level stripped <script>/<style>/<noscript> from it
// in place, corrupting the DOM other rules saw (and, with rules now running
// concurrently, racing against them). These rules now read text non-mutatively
// via getTextExcludingScripts. This guards that they leave the DOM intact AND
// that the helper output matches the old "remove then read textContent".

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { keywordStuffingRule } from "../src/content/keyword-stuffing";
import { readingLevelRule } from "../src/content/reading-level";
import { getProseTextExcludingCode, getTextExcludingScripts } from "../src/content/text-content";
import type { ParsedPage, RuleContext } from "../src/types";

const HTML = `<html><body>
  <p>${"keyword ".repeat(150)}</p>
  <script>var noise = "should not count keyword keyword keyword";</script>
  <style>.x{content:"keyword"}</style>
  <noscript>fallback keyword text</noscript>
  <article>The cat sat on the mat. Dogs run fast. Birds fly high. Fish swim deep. Trees grow tall.</article>
</body></html>`;

function makeCtx(doc: ReturnType<typeof parseHTML>["document"]): RuleContext {
  return {
    page: { url: "https://example.com/", html: HTML, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: doc } as unknown as ParsedPage,
    options: {},
  };
}

describe("content rules do not mutate the shared DOM", () => {
  test("getTextExcludingScripts matches remove-then-textContent", () => {
    const a = parseHTML(HTML).document.querySelector("body")!;
    const b = parseHTML(HTML).document.querySelector("body")!;

    // Reference: the previous mutating approach.
    for (const el of b.querySelectorAll("script, style, noscript")) el.remove();
    const reference = b.textContent || "";

    expect(getTextExcludingScripts(a)).toBe(reference);
  });

  test("getProseTextExcludingCode drops code-like tags and nothing else", () => {
    const html = `<html><body><p>prose <code>literal</code> more</p>
      <pre>block</pre><samp>output</samp><kbd>keys</kbd>
      <script>var s = "noise";</script></body></html>`;
    const a = parseHTML(html).document.querySelector("body")!;
    const b = parseHTML(html).document.querySelector("body")!;

    for (const el of b.querySelectorAll("script, style, noscript, code, pre, samp, kbd")) {
      el.remove();
    }

    // Deliberately NOT byte-identical to remove-then-textContent: a newline stands
    // in for each skipped subtree, because removing an element glues its
    // neighbours and the caller scans the result for character sequences. Ignoring
    // the inserted newlines, no surviving text is lost, gained or reordered.
    const stripNewlines = (s: string) => s.replaceAll("\n", "");
    expect(stripNewlines(getProseTextExcludingCode(a))).toBe(stripNewlines(b.textContent || ""));
    expect(getProseTextExcludingCode(a)).toContain("\n");
    // And it leaves the DOM it read intact.
    expect(a.querySelectorAll("code, pre, samp, kbd").length).toBe(4);
  });

  test("keyword-stuffing leaves script/style/noscript nodes in the DOM", async () => {
    const doc = parseHTML(HTML).document;
    const before = doc.querySelectorAll("script, style, noscript").length;
    expect(before).toBeGreaterThan(0);

    await keywordStuffingRule.run(makeCtx(doc));

    expect(doc.querySelectorAll("script, style, noscript").length).toBe(before);
  });

  test("reading-level leaves script/style/noscript nodes in the DOM", async () => {
    const doc = parseHTML(HTML).document;
    const before = doc.querySelectorAll("script, style, noscript").length;
    expect(before).toBeGreaterThan(0);

    await readingLevelRule.run(makeCtx(doc));

    expect(doc.querySelectorAll("script, style, noscript").length).toBe(before);
  });

  test("both rules running on the SAME doc see the full, uncorrupted DOM", async () => {
    const doc = parseHTML(HTML).document;
    // Run keyword-stuffing first; reading-level must still see script/style.
    await keywordStuffingRule.run(makeCtx(doc));
    const r = await readingLevelRule.run(makeCtx(doc));
    // It produced real readability checks (not the "too short" early-out), proving
    // it read the same body text either rule order would yield.
    expect(r.checks.length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("script").length).toBeGreaterThan(0);
  });
});
