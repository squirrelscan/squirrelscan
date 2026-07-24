// ai/ai-content - AI content detection (retired)

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

/**
 * RETIRED (#365): this rule previously called an LLM per page with no credit
 * charge wired — a leaky, uncatalogued cost. It is now a hard-guarded no-op so
 * it can never invoke an LLM. Re-enabling AI content detection requires a
 * metered server endpoint (Pangram, opt-in only) before any model call.
 */
export const aiContentRule: Rule = {
  meta: {
    id: "ai/ai-content",
    name: "AI Content Detection",
    description: "Detects if content appears to be AI-generated",
    solution:
      "AI content detection is currently unavailable. When re-enabled it will run as an opt-in, metered cloud check.",
    category: "ax",
    scope: "page",
    severity: "info",
    weight: 2,
    disabled: true,
  },

  async run(_ctx: RuleContext): Promise<RuleResult> {
    return {
      checks: [
        {
          name: "ai-content",
          status: "skipped",
          message: "AI content detection is retired",
          skipReason: "Retired pending a metered opt-in endpoint",
        },
      ],
    };
  },
};
