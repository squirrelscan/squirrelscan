// ax/noai-signals — noai / noimageai / snippet-limit reporting (page scope).

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { noaiSignalsRule, detectAiOptOuts } from "../src/ax/noai-signals";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(html: string, headers: Record<string, string> = {}): RuleContext {
  const doc = parseHTML(html).document;
  return {
    page: { url: "https://example.com/", html, statusCode: 200, loadTime: 0, headers },
    parsed: { document: doc, meta: { robots: null } } as unknown as ParsedPage,
    options: {},
  } as unknown as RuleContext;
}

function run(html: string, headers?: Record<string, string>): CheckResult[] {
  return noaiSignalsRule.run(ctx(html, headers)).checks;
}

describe("detectAiOptOuts", () => {
  test("noai does not false-match inside noimageai", () => {
    const f = detectAiOptOuts("noimageai");
    expect(f.noimageai).toBe(true);
    expect(f.noai).toBe(false);
  });

  test("detects max-snippet:0 with loose spacing", () => {
    expect(detectAiOptOuts("max-snippet: 0").maxSnippet0).toBe(true);
    expect(detectAiOptOuts("max-snippet:5").maxSnippet0).toBe(false);
  });

  test("empty input yields no flags", () => {
    expect(detectAiOptOuts(null)).toEqual({
      noai: false,
      noimageai: false,
      nosnippet: false,
      maxSnippet0: false,
    });
  });
});

describe("ax/noai-signals rule", () => {
  test("a clean page passes quietly with a single check", () => {
    const checks = run("<html><head></head><body><p>hi</p></body></html>");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });

  test("reports a meta-robots noai opt-out as info with the advisory caveat", () => {
    const checks = run('<html><head><meta name="robots" content="noai, noimageai"></head><body></body></html>');
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("noai");
    expect(checks[0]?.message).toContain("advisory");
    expect(checks[0]?.details?.noai).toBe(true);
    expect(checks[0]?.details?.noimageai).toBe(true);
  });

  test("reads the X-Robots-Tag header and flags snippet limits as AI-search quoting", () => {
    const checks = run("<html><head></head><body></body></html>", {
      "x-robots-tag": "nosnippet, max-snippet:0",
    });
    expect(checks[0]?.status).toBe("info");
    expect(checks[0]?.message).toContain("AI-search quoting");
    // No advisory caveat when only the well-established snippet directives are set.
    expect(checks[0]?.message).not.toContain("advisory");
    expect(checks[0]?.details?.nosnippet).toBe(true);
    expect(checks[0]?.details?.maxSnippet0).toBe(true);
  });

  test("ignores unrelated meta names", () => {
    const checks = run('<html><head><meta name="description" content="noai in the copy"></head><body></body></html>');
    expect(checks[0]?.status).toBe("pass");
  });
});
