// ax/token-weight — per-page text-to-HTML ratio + estimated token budget.

import { describe, expect, test } from "bun:test";

import type { ContentAnalysis } from "@squirrelscan/core-contracts";

import { tokenWeightRule } from "../src/ax/token-weight";
import type { ParsedPage, RuleContext } from "../src/types";

function content(over: Partial<ContentAnalysis> = {}): ContentAnalysis {
  return {
    wordCount: 500,
    textLength: 3000,
    htmlLength: 10_000,
    textToHtmlRatio: 0.3,
    isThinContent: false,
    contentHash: "hash",
    textContent: "text",
    ...over,
  };
}

function ctx(html: string, over: Partial<ContentAnalysis> = {}): RuleContext {
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: { document: {}, content: content(over) } as unknown as ParsedPage,
    options: {},
  };
}

function run(html: string, over: Partial<ContentAnalysis> = {}) {
  return tokenWeightRule.run(ctx(html, over)).checks;
}

// Padding so byte-size floor is cleared regardless of ratio under test.
const PAD = "x".repeat(2_000);

describe("ax/token-weight", () => {
  test("tiny page (below size floor) → skipped, not a false positive", () => {
    const checks = run("<html></html>", { textToHtmlRatio: 0 });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("skipped");
  });

  test("no parsed document (error page) → skipped", () => {
    const checks = tokenWeightRule.run({
      page: { url: "https://example.com/", html: PAD, statusCode: 404, loadTime: 0, headers: {} },
      parsed: { document: null, content: content() } as unknown as ParsedPage,
      options: {},
    }).checks;
    expect(checks[0]?.status).toBe("skipped");
  });

  // pub#1011: only a genuine small 2xx page is "does not apply"; a missing document or a
  // small non-2xx body is the check not running, so a prior finding carries.
  test("a small 2xx page is not applicable; a missing document or a small non-2xx page is a gap", () => {
    expect(run("<html></html>", { textToHtmlRatio: 0 })[0]?.skipReason).toBe("not-applicable");
    const gap = (html: string, statusCode: number, document: unknown) =>
      tokenWeightRule.run({
        page: { url: "https://example.com/", html, statusCode, loadTime: 0, headers: {} },
        parsed: { document, content: content() } as unknown as ParsedPage,
        options: {},
      }).checks[0];
    expect(gap(PAD, 404, null)?.skipReason).toBe("below minimum size");
    expect(gap("<html></html>", 503, {})?.skipReason).toBe("below minimum size");
    expect(gap("<html></html>", 503, {})?.details).toBeUndefined();
  });

  test("healthy ratio + reasonable size → both checks pass", () => {
    const checks = run(PAD, { textToHtmlRatio: 0.3 });
    const ratio = checks.find((c) => c.name === "token-weight-ratio");
    const budget = checks.find((c) => c.name === "token-weight-budget");
    expect(ratio?.status).toBe("pass");
    expect(budget?.status).toBe("pass");
  });

  test("ratio below 15% → warn", () => {
    const checks = run(PAD, { textToHtmlRatio: 0.05 });
    const ratio = checks.find((c) => c.name === "token-weight-ratio");
    expect(ratio?.status).toBe("warn");
    expect(ratio?.value).toBe(5);
    expect(ratio?.message).toContain("15%");
  });

  test("huge raw HTML exceeds token budget → warn", () => {
    const hugeHtml = "x".repeat(500_000); // ~125k estimated tokens at bytes/4
    const checks = run(hugeHtml, { textToHtmlRatio: 0.3 });
    const budget = checks.find((c) => c.name === "token-weight-budget");
    expect(budget?.status).toBe("warn");
    expect(budget?.value).toBeGreaterThan(100_000);
  });

  test("severity is warning-capable: warn checks actually use status warn (not info)", () => {
    const checks = run(PAD, { textToHtmlRatio: 0.01 });
    expect(checks.some((c) => c.status === "warn")).toBe(true);
  });
});
