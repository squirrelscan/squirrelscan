// core/h1 - Validates H1 tag presence and uniqueness

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const h1Rule: Rule = {
  meta: {
    id: "core/h1",
    name: "H1 Tag",
    description: "Validates H1 tag presence and uniqueness",
    solution:
      "Each page should have exactly one H1 tag that clearly describes the main topic. The H1 is the primary heading users and search engines see, and it should align with the page title while being more detailed. If missing, add an H1 at the top of your main content. If you have multiple H1s, demote extras to H2 or lower. Ensure the H1 is descriptive and contains relevant keywords naturally.",
    category: "core",
    scope: "page",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const { h1 } = ctx.parsed;
    const checks: CheckResult[] = [];

    if (h1.count === 0) {
      checks.push({
        name: "h1",
        status: "fail",
        message: "No H1 tag found",
        value: 0,
        expected: 1,
      });
      return { checks };
    }

    if (h1.count > 1) {
      checks.push({
        name: "h1",
        status: "warn",
        message: `Multiple H1 tags found (${h1.count})`,
        value: h1.count,
        expected: 1,
      });
      return { checks };
    }

    // Check if H1 is empty
    const h1Text = h1.texts[0];
    if (!h1Text || h1Text.length === 0) {
      checks.push({
        name: "h1",
        status: "warn",
        message: "H1 tag is empty",
        value: "",
      });
      return { checks };
    }

    checks.push({
      name: "h1",
      status: "pass",
      message: "Single H1 tag present",
      value: h1Text,
    });

    return { checks };
  },
};
