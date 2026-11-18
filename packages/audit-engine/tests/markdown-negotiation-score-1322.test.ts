// ax/markdown-response is advisory (severity info): absent Markdown is a
// score-neutral recommendation. A 5xx to strict `Accept: text/markdown` is a
// defect and must move the score (repo#1322). Scored through the real rule.

import { describe, expect, test } from "bun:test";

import type { MarkdownProbeData } from "@squirrelscan/core-contracts";
import type { RuleContext, RuleRunResult, ParsedPage } from "@squirrelscan/rules/types";
import { loadAllRules } from "@squirrelscan/rules";

import { calculateHealthScore } from "../src/scoring";

function probe(over: Partial<MarkdownProbeData>): MarkdownProbeData {
  return {
    negotiatedUrl: "https://example.com/",
    negotiatedContentType: "text/html",
    servesMarkdown: false,
    mdVariantUrl: "https://example.com/index.md",
    mdVariantExists: false,
    mdVariantContentType: null,
    negotiatedStatus: 200,
    ...over,
  };
}

const markdownResponseRule = loadAllRules().get("ax/markdown-response")!;

async function ruleResult(markdownResponse: MarkdownProbeData): Promise<RuleRunResult> {
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, markdownResponse },
    options: {},
  };
  const { checks } = await markdownResponseRule.run(ctx);
  return { meta: markdownResponseRule.meta, checks } as RuleRunResult;
}

// A scored rule so the ax category always has weight.
const ANCHOR = {
  meta: { ...markdownResponseRule.meta, id: "ax/anchor", name: "Anchor", severity: "warning" as const, weight: 2 },
  checks: [{ name: "anchor", status: "pass" as const, message: "ok" }],
} as RuleRunResult;

function axScore(results: RuleRunResult[]): number | undefined {
  const map = new Map(results.map((r) => [r.meta.id, r]));
  return calculateHealthScore({ results: map }).categories.find((c) => c.category === "ax")?.score;
}

describe("ax/markdown-response scoring (repo#1322)", () => {
  test("absent Markdown is score-neutral", async () => {
    const absent = await ruleResult(probe({ strictNegotiatedStatus: 200 }));
    expect(axScore([ANCHOR, absent])).toBe(axScore([ANCHOR]));
  });

  test("a 5xx on strict negotiation lowers the score", async () => {
    const broken = await ruleResult(probe({ strictNegotiatedStatus: 500 }));
    expect(axScore([ANCHOR, broken])!).toBeLessThan(axScore([ANCHOR])!);
  });
});
