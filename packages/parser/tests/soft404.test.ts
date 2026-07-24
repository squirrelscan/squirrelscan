// Soft-404 detection — conservative ≥2-signal-with-strong-anchor logic.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { detectSoft404, hasErrorShellMarker, looksLikeNotFoundText, parsePage } from "../src/index";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

describe("looksLikeNotFoundText", () => {
  test.each([
    "Page Not Found",
    "Page Not Found | Example Site",
    "404 Not Found",
    "404 - Not Found",
    "Error 404",
    "This page does not exist",
    "This page doesn't exist",
    "The content could not be found",
  ])("matches %j", (s) => {
    expect(looksLikeNotFoundText(s)).toBe(true);
  });

  test.each([
    "How to fix 404 errors",
    "The 404 status code explained",
    "About Us",
    "Welcome to the Foundation",
    "Lost and Found: a short story",
    // Bare not-found/no-longer phrases inside a real title must NOT be strong —
    // the phrase needs a subject qualifier (page/content/post/article/url).
    "How to Fix File Not Found Errors",
    "This Item Is No Longer Available",
    "Cannot be found: debugging missing modules",
    "",
    null,
  ])("does not match %j", (s) => {
    expect(looksLikeNotFoundText(s as string)).toBe(false);
  });
});

describe("hasErrorShellMarker", () => {
  test("detects the Next.js __next_error__ root id", () => {
    const { document } = parseFixtureDoc('<html id="__next_error__"><body></body></html>');
    expect(hasErrorShellMarker(document)).toBe(true);
  });

  test("is false for a normal document", () => {
    const { document } = parseFixtureDoc("<html><body><h1>Hi</h1></body></html>");
    expect(hasErrorShellMarker(document)).toBe(false);
  });
});

function parseFixtureDoc(html: string) {
  const parsed = parsePage(html, "https://example.com/");
  return { document: parsed.document };
}

describe("detectSoft404", () => {
  test("flags a 200 Next.js error shell with not-found title + noindex (real shape)", () => {
    const parsed = parsePage(fixture("soft-404-next-error.html"), "https://example.com/blog/gone");
    const result = detectSoft404({
      statusCode: 200,
      document: parsed.document,
      title: parsed.meta.title,
      h1Texts: parsed.h1.texts,
      robotsMeta: parsed.meta.robots,
      wordCount: parsed.content.wordCount,
    });
    expect(result.isSoft404).toBe(true);
    const names = result.signals.map((s) => s.name).sort();
    expect(names).toContain("error-shell");
    expect(names).toContain("not-found-title");
    expect(names).toContain("not-found-heading");
    expect(names).toContain("noindex");
  });

  test("flags a custom 404 template (200, title + h1 not-found, no shell/noindex)", () => {
    const result = detectSoft404({
      statusCode: 200,
      document: null,
      title: "Page Not Found",
      h1Texts: ["Page Not Found"],
      robotsMeta: null,
      wordCount: 400, // real footer/nav text — above the tiny threshold
    });
    expect(result.isSoft404).toBe(true);
    expect(result.signals.map((s) => s.name).sort()).toEqual([
      "not-found-heading",
      "not-found-title",
    ]);
  });

  test.each(["The page can't be found", "This page can not be found", "Page cannot be found"])(
    "matches broadened cannot-be-found phrasing: %j",
    (title) => {
      expect(looksLikeNotFoundText(title)).toBe(true);
    }
  );

  test.each(["How to Fix File Not Found Errors", "This Item Is No Longer Available"])(
    "does NOT flag a real page whose title has a bare not-found phrase + a supporting signal: %j",
    (title) => {
      const result = detectSoft404({
        statusCode: 200,
        document: null,
        title,
        h1Texts: [title],
        robotsMeta: "noindex", // stale-post noindex — a supporting signal
        wordCount: 8, // also tiny — still must not flag without a STRONG signal
      });
      expect(result.isSoft404).toBe(false);
      expect(result.signals.some((s) => s.strong)).toBe(false);
    }
  );

  test("does NOT flag a real 404 response (status 404)", () => {
    const parsed = parsePage(fixture("soft-404-next-error.html"), "https://example.com/blog/gone");
    const result = detectSoft404({
      statusCode: 404,
      document: parsed.document,
      title: parsed.meta.title,
      h1Texts: parsed.h1.texts,
      robotsMeta: parsed.meta.robots,
      wordCount: parsed.content.wordCount,
    });
    expect(result.isSoft404).toBe(false);
  });

  test("does NOT flag a legit article mentioning 404 in the title", () => {
    const result = detectSoft404({
      statusCode: 200,
      document: null,
      title: "How to fix 404 errors",
      h1Texts: ["How to fix 404 errors"],
      robotsMeta: null,
      wordCount: 1200,
    });
    expect(result.isSoft404).toBe(false);
  });

  test("requires a STRONG signal — noindex + tiny content alone do not flag", () => {
    const result = detectSoft404({
      statusCode: 200,
      document: null,
      title: "Tag: react",
      h1Texts: ["react"],
      robotsMeta: "noindex, follow",
      wordCount: 5,
    });
    expect(result.isSoft404).toBe(false);
    expect(result.signals.some((s) => s.strong)).toBe(false);
  });

  test("requires TWO signals — a lone not-found title does not flag", () => {
    const result = detectSoft404({
      statusCode: 200,
      document: null,
      title: "Page Not Found",
      h1Texts: [],
      robotsMeta: null,
      wordCount: 800, // not tiny
    });
    expect(result.isSoft404).toBe(false);
    expect(result.signals).toHaveLength(1);
  });

  test("flags on not-found title + tiny content (no error shell)", () => {
    const result = detectSoft404({
      statusCode: 200,
      document: null,
      title: "Page not found",
      h1Texts: [],
      robotsMeta: null,
      wordCount: 8,
    });
    expect(result.isSoft404).toBe(true);
  });
});
