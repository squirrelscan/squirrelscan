// ax/markdown-response — markdown content negotiation + .md variant (#394).

import { describe, expect, test } from "bun:test";

import type { CheckResult, MarkdownProbeData } from "@squirrelscan/core-contracts";

import { markdownResponseRule } from "../src/ax/markdown-response";
import type { ParsedPage, RuleContext } from "../src/types";

function probe(over: Partial<MarkdownProbeData> = {}): MarkdownProbeData {
  return {
    negotiatedUrl: "https://example.com/",
    negotiatedContentType: "text/html",
    servesMarkdown: false,
    mdVariantUrl: "https://example.com/index.md",
    mdVariantExists: false,
    mdVariantContentType: null,
    negotiatedVary: null,
    markdownTokensHeader: null,
    originalTokensHeader: null,
    alternateMarkdownUrl: null,
    ...over,
  };
}

function ctx(markdownResponse: MarkdownProbeData | null | undefined): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      markdownResponse,
    },
    options: {},
  };
}

function run(m: MarkdownProbeData | null | undefined): CheckResult[] {
  return markdownResponseRule.run(ctx(m)).checks;
}

describe("ax/markdown-response", () => {
  test("data unavailable → info, no crash", () => {
    const c = run(undefined);
    expect(c[0]?.status).toBe("info");
    expect(c[0]?.message).toContain("not available");
  });

  test("no markdown signal → absent surfaces as warn-status recommendation", () => {
    const c = run(probe());
    expect(c[0]?.value).toBe("absent");
    // warn-status in this info-severity rule = shown as a Recommendation in
    // the report but score-neutral (advisory scoring).
    expect(c[0]?.status).toBe("warn");
  });

  test("content negotiation serves markdown → available", () => {
    const c = run(probe({ servesMarkdown: true, negotiatedContentType: "text/markdown" }));
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.message).toContain("content negotiation");
  });

  test(".md variant present → available", () => {
    const c = run(probe({ mdVariantExists: true, mdVariantContentType: "text/markdown" }));
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.message).toContain(".md variant");
  });

  test("both signals listed together", () => {
    const c = run(
      probe({
        servesMarkdown: true,
        negotiatedContentType: "text/markdown",
        mdVariantExists: true,
        mdVariantContentType: "text/markdown",
      }),
    );
    expect(c[0]?.message).toContain("content negotiation");
    expect(c[0]?.message).toContain(".md variant");
  });

  test("no check ever fails; markdown present → all info", () => {
    expect(run(probe()).every((c) => c.status !== "fail")).toBe(true);
    expect(run(probe({ servesMarkdown: true, negotiatedContentType: "text/markdown" })).every((c) => c.status === "info")).toBe(
      true,
    );
  });

  test("no header signals → no headers check emitted", () => {
    const c = run(probe());
    expect(c.find((r) => r.name === "markdown-response-headers")).toBeUndefined();
  });

  test("Vary: Accept present → surfaced in headers check", () => {
    const c = run(probe({ servesMarkdown: true, negotiatedVary: "Accept" }));
    const headers = c.find((r) => r.name === "markdown-response-headers");
    expect(headers?.message).toContain("Vary: Accept");
  });

  test("Vary present but doesn't mention Accept → not surfaced as a negotiation signal", () => {
    const c = run(probe({ negotiatedVary: "Origin" }));
    expect(c.find((r) => r.name === "markdown-response-headers")).toBeUndefined();
  });

  test("Cloudflare token fingerprint headers → surfaced with computed percentage", () => {
    const c = run(probe({ markdownTokensHeader: "100", originalTokensHeader: "400" }));
    const headers = c.find((r) => r.name === "markdown-response-headers");
    expect(headers?.message).toContain("x-markdown-tokens: 100");
    expect(headers?.message).toContain("x-original-tokens: 400");
    expect(headers?.message).toContain("25%");
  });

  test("alternate Markdown Link alone → available (primary signal)", () => {
    // A site whose homepage renders HTML but advertises a markdown twin via
    // Link: rel=alternate is serving markdown — not scored as absent.
    const c = run(probe({ alternateMarkdownUrl: "https://example.com/index.md" }));
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.status).toBe("info");
    expect(c[0]?.message).toContain("link rel=alternate");
    expect(c[0]?.details?.alternateMarkdownUrl).toBe("https://example.com/index.md");
    // No longer double-reported as a supplementary headers signal.
    expect(c.find((r) => r.name === "markdown-response-headers")).toBeUndefined();
  });

  test("header signals check itself is always info", () => {
    const c = run(
      probe({
        negotiatedVary: "Accept",
        markdownTokensHeader: "10",
        originalTokensHeader: "40",
        alternateMarkdownUrl: "https://example.com/index.md",
      }),
    );
    expect(c.find((r) => r.name === "markdown-response-headers")?.status).toBe("info");
  });
});
