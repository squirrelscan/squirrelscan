// ai/llm-parsability - LLM parsability analysis (cloud-backed)

import type { AiParseResult } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

export const llmParsabilityRule: Rule = {
  meta: {
    id: "ai/llm-parsability",
    name: "LLM Parsability",
    description: "Analyzes how well LLMs can parse and understand the content",
    solution:
      "This rule evaluates how well LLMs can understand and extract information from your content, which affects AI-powered search and assistants. Improve parsability by using clear structure, explicit topic sentences, and well-organized sections. Avoid ambiguous pronouns and ensure context is clear. Use semantic HTML and structured data. Clear, well-written content for humans typically scores well for LLM parsability too.",
    category: "ax",
    scope: "page",
    severity: "info",
    weight: 3,
    cloud: { service: "ai-parse", unit: "page", creditFeature: "ai_parse" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<AiParseResult>(ctx.cloudResults, "ai-parse", ctx.page.url);
    if (!envelope || envelope.status === "skipped") {
      const reason = envelope?.skipReason ?? "not-prefetched";
      checks.push({
        name: "llm-parsability",
        status: "skipped",
        message: "LLM parsability analysis skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const score = Math.round(envelope.data?.parsabilityScore ?? 0);
    let status: CheckResult["status"] = "pass";
    let message: string;

    if (score >= 70) {
      status = "pass";
      message = `LLM parsability score: ${score}/100`;
    } else if (score >= 40) {
      status = "warn";
      message = `LLM parsability could be improved: ${score}/100`;
    } else {
      status = "fail";
      message = `Poor LLM parsability: ${score}/100`;
    }

    checks.push({
      name: "llm-parsability",
      status,
      message,
      value: String(score),
      expected: ">= 70",
    });

    return { checks };
  },
};
