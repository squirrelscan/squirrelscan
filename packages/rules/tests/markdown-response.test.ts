// ax/markdown-response — markdown content negotiation + .md variant (#394).

import type {
  CheckResult,
  MarkdownProbeData,
} from "@squirrelscan/core-contracts";

import { STRICT_PROBE_UNANSWERED_SKIP_REASON } from "@squirrelscan/core-contracts";
import {
  classifyRuleOutcome,
  skipReasonClass,
} from "@squirrelscan/core-contracts/rule-outcome";
import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext } from "../src/types";

import { markdownResponseRule } from "../src/ax/markdown-response";

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

function ctx(
  markdownResponse: MarkdownProbeData | null | undefined
): RuleContext {
  return {
    page: {
      url: "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
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

async function run(
  m: MarkdownProbeData | null | undefined
): Promise<CheckResult[]> {
  return (await markdownResponseRule.run(ctx(m))).checks;
}

describe("ax/markdown-response", () => {
  test("data unavailable → not checked info, no crash", async () => {
    const c = await run(undefined);
    expect(c[0]?.status).toBe("skipped");
    expect(c[0]?.value).toBe("not-checked");
    expect(c[0]?.message).toContain("not checked");
  });

  test("no markdown signal → absent surfaces as warn-status recommendation", async () => {
    const c = await run(probe());
    expect(c[0]?.value).toBe("absent");
    // warn-status in this info-severity rule = shown as a Recommendation in
    // the report but score-neutral (advisory scoring).
    expect(c[0]?.status).toBe("warn");
  });

  test("content negotiation serves markdown → available", async () => {
    const c = await run(
      probe({ servesMarkdown: true, negotiatedContentType: "text/markdown" })
    );
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.message).toContain("content negotiation");
  });

  test(".md variant present → available", async () => {
    const c = await run(
      probe({ mdVariantExists: true, mdVariantContentType: "text/markdown" })
    );
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.message).toContain(".md variant");
  });

  test("both signals listed together", async () => {
    const c = await run(
      probe({
        servesMarkdown: true,
        negotiatedContentType: "text/markdown",
        mdVariantExists: true,
        mdVariantContentType: "text/markdown",
      })
    );
    expect(c[0]?.message).toContain("content negotiation");
    expect(c[0]?.message).toContain(".md variant");
  });

  test("absent markdown never fails; markdown present → all info", async () => {
    expect((await run(probe())).every((c) => c.status !== "fail")).toBe(true);
    expect(
      (
        await run(
          probe({
            servesMarkdown: true,
            negotiatedContentType: "text/markdown",
          })
        )
      ).every((c) => c.status === "info")
    ).toBe(true);
  });

  test("no header signals → no headers check emitted", async () => {
    const c = await run(probe());
    expect(
      c.find((r) => r.name === "markdown-response-headers")
    ).toBeUndefined();
  });

  test("Vary: Accept present → surfaced in headers check", async () => {
    const c = await run(
      probe({ servesMarkdown: true, negotiatedVary: "Accept" })
    );
    const headers = c.find((r) => r.name === "markdown-response-headers");
    expect(headers?.message).toContain("Vary: Accept");
  });

  test("Vary present but doesn't mention Accept → not surfaced as a negotiation signal", async () => {
    const c = await run(probe({ negotiatedVary: "Origin" }));
    expect(
      c.find((r) => r.name === "markdown-response-headers")
    ).toBeUndefined();
  });

  test("Cloudflare token fingerprint headers → surfaced with computed percentage", async () => {
    const c = await run(
      probe({ markdownTokensHeader: "100", originalTokensHeader: "400" })
    );
    const headers = c.find((r) => r.name === "markdown-response-headers");
    expect(headers?.message).toContain("x-markdown-tokens: 100");
    expect(headers?.message).toContain("x-original-tokens: 400");
    expect(headers?.message).toContain("25%");
  });

  test("alternate Markdown Link alone → available (primary signal)", async () => {
    // A site whose homepage renders HTML but advertises a markdown twin via
    // Link: rel=alternate is serving markdown — not scored as absent.
    const c = await run(
      probe({ alternateMarkdownUrl: "https://example.com/index.md" })
    );
    expect(c[0]?.value).toBe("available");
    expect(c[0]?.status).toBe("info");
    expect(c[0]?.message).toContain("link rel=alternate");
    expect(c[0]?.details?.alternateMarkdownUrl).toBe(
      "https://example.com/index.md"
    );
    // No longer double-reported as a supplementary headers signal.
    expect(
      c.find((r) => r.name === "markdown-response-headers")
    ).toBeUndefined();
  });

  test("header signals check itself is always info", async () => {
    const c = await run(
      probe({
        negotiatedVary: "Accept",
        markdownTokensHeader: "10",
        originalTokensHeader: "40",
        alternateMarkdownUrl: "https://example.com/index.md",
      })
    );
    expect(c.find((r) => r.name === "markdown-response-headers")?.status).toBe(
      "info"
    );
  });

  describe("strict negotiation 5xx vs absent markdown (repo#1322)", () => {
    test("5xx on strict Accept: text/markdown → distinct fail check, not the absent recommendation", async () => {
      const c = await run(
        probe({
          negotiatedStatus: 200,
          strictNegotiatedStatus: 500,
          strictNegotiatedContentType: "application/json",
        })
      );
      const error = c.find((r) => r.name === "markdown-negotiation-error");
      expect(error).toBeDefined();
      // fail, not warn: a warn in this info-severity rule is score-neutral.
      expect(error?.status).toBe("fail");
      expect(error?.value).toBe(500);
      expect(error?.message).toContain("HTTP 500");
      expect(error?.message).not.toContain("No Markdown response");
      expect(error?.details?.strictNegotiatedContentType).toBe(
        "application/json"
      );
      // The primary check is still first and still reports markdown as absent.
      expect(c[0]?.name).toBe("markdown-response");
      expect(c[0]?.value).toBe("absent");
    });

    test("absent markdown (strict answered 200 HTML or 406) → only the advisory check, no error", async () => {
      for (const strictNegotiatedStatus of [200, 404, 406, null, undefined]) {
        const c = await run(
          probe({ negotiatedStatus: 200, strictNegotiatedStatus })
        );
        expect(
          c.find((r) => r.name === "markdown-negotiation-error")
        ).toBeUndefined();
        expect(c.every((r) => r.status !== "fail")).toBe(true);
        expect(c[0]?.name).toBe("markdown-response");
        expect(c[0]?.status).toBe("warn");
        expect(c[0]?.value).toBe("absent");
        expect(c[0]?.message).toContain("No Markdown response");
      }
    });

    test("every 5xx status is flagged; 4xx is not", async () => {
      for (const status of [500, 502, 503, 504]) {
        const c = await run(probe({ strictNegotiatedStatus: status }));
        expect(
          c.find((r) => r.name === "markdown-negotiation-error")?.status
        ).toBe("fail");
      }
      const notAcceptable = await run(probe({ strictNegotiatedStatus: 406 }));
      expect(
        notAcceptable.find((r) => r.name === "markdown-negotiation-error")
      ).toBeUndefined();
    });

    test("5xx on strict while a .md variant exists → still flagged alongside available", async () => {
      const c = await run(
        probe({
          strictNegotiatedStatus: 503,
          mdVariantExists: true,
          mdVariantContentType: "text/markdown",
        })
      );
      expect(c[0]?.value).toBe("available");
      expect(
        c.find((r) => r.name === "markdown-negotiation-error")?.status
      ).toBe("fail");
    });

    test("strict-only Markdown names the strict content type, not the lenient HTML", async () => {
      const c = await run(
        probe({
          servesMarkdown: true,
          negotiatedContentType: "text/html",
          strictNegotiatedStatus: 200,
          strictNegotiatedContentType: "text/markdown; charset=utf-8",
        })
      );
      expect(c[0]?.value).toBe("available");
      expect(c[0]?.message).toContain(
        "content negotiation (text/markdown; charset=utf-8)"
      );
    });
  });

  // planning's finding on pub#1932: no answer to the strict request (429, 403, a
  // timeout, the probe budget) was read as clean, so audit 2 closed the finding
  // audit 1 opened. It is its own state now: a coded gap, never a verdict.
  describe("strict probe unanswered vs answered (repo#1322)", () => {
    const negotiation = (c: CheckResult[]) =>
      c.find((r) => r.name === "markdown-negotiation-error");

    test("strict unanswered (429, 403, timeout) → skipped with the coded strict-probe-unanswered reason", async () => {
      const c = await run(
        probe({
          negotiatedStatus: 200,
          strictNegotiatedStatus: null,
          strictNegotiationAnswered: false,
        })
      );
      const check = negotiation(c);
      expect(check?.status).toBe("skipped");
      expect(check?.skipReason).toBe(STRICT_PROBE_UNANSWERED_SKIP_REASON);
      // A coverage gap a report lists as not checked, so it never resolves a finding.
      expect(classifyRuleOutcome(check!)).toBe("coverage_gap");
      expect(skipReasonClass(check?.skipReason)?.notChecked).toBe(true);
      // Not a fail and not the absent recommendation's job to say.
      expect(c.every((r) => r.status !== "fail")).toBe(true);
    });

    test("strict 500 → the error finding, unchanged", async () => {
      const c = await run(
        probe({
          negotiatedStatus: 200,
          strictNegotiatedStatus: 500,
          strictNegotiationAnswered: true,
        })
      );
      expect(negotiation(c)?.status).toBe("fail");
      expect(negotiation(c)?.value).toBe(500);
    });

    test("strict answered healthy (200 HTML, 406) → a verdict, neither error nor gap", async () => {
      for (const status of [200, 406]) {
        const c = await run(
          probe({
            negotiatedStatus: 200,
            strictNegotiatedStatus: status,
            strictNegotiationAnswered: true,
          })
        );
        const check = negotiation(c);
        expect(check).toBeDefined();
        // info, not pass: a pass would score this advisory rule for every healthy site.
        expect(check?.status).toBe("info");
        expect(check?.value).toBe(status);
        expect(classifyRuleOutcome(check!)).toBe("ran");
      }
    });

    test("strict 5xx with /index.md unanswered → no absent warning for a file that never answered", async () => {
      const c = await run(
        probe({
          negotiatedStatus: 200,
          strictNegotiatedStatus: 502,
          strictNegotiationAnswered: true,
          mdVariantAnswered: false,
        })
      );
      expect(negotiation(c)?.status).toBe("fail");
      const primary = c.find((r) => r.name === "markdown-response");
      expect(primary?.value).not.toBe("absent");
      expect(primary?.status).toBe("skipped");
      expect(c.some((r) => /No Markdown response/.test(r.message))).toBe(false);
    });

    test("a row stored before the answered flags reads as before: no verdict, no gap", async () => {
      const c = await run(
        probe({ negotiatedStatus: 200, strictNegotiatedStatus: null })
      );
      expect(negotiation(c)).toBeUndefined();
      expect(c[0]?.value).toBe("absent");
    });
  });
});
