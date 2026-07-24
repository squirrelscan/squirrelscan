// core/nosnippet - Detects pages preventing search engine snippets

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const nosnippetRule: Rule = {
  meta: {
    id: "core/nosnippet",
    name: "Nosnippet Directive",
    description: "Detects pages preventing search engine snippets",
    solution: `The nosnippet directive prevents search engines from showing descriptions in search results, severely harming click-through rates.

Found in: <meta name="robots" content="nosnippet">
Or: <meta name="robots" content="max-snippet:0">

This is almost always unintentional. Remove unless you specifically need to hide snippets (e.g., login pages, legal content).

Note: max-snippet:N where N > 0 is fine (sets snippet character limit).`,
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const { robots } = ctx.parsed.meta;

    if (!robots) {
      checks.push({
        name: "nosnippet",
        status: "pass",
        message: "No snippet restrictions found",
      });
      return { checks };
    }

    const robotsLower = robots.toLowerCase();

    // Parse content for directives (comma or space separated)
    const directives = robotsLower.split(/[,\s]+/).map((d) => d.trim());

    // Check for nosnippet
    const hasNosnippet = directives.includes("nosnippet");

    // Check for max-snippet:0 (only 0 is problematic)
    const hasMaxSnippetZero = directives.some((d) => {
      const match = d.match(/^max-snippet:(\d+)$/);
      return match && match[1] === "0";
    });

    if (hasNosnippet || hasMaxSnippetZero) {
      const directive = hasNosnippet ? "nosnippet" : "max-snippet:0";
      checks.push({
        name: "nosnippet",
        status: "warn",
        message: `Page has ${directive} directive - prevents SERP snippets`,
        value: robots,
        expected: "Remove to allow search snippets",
      });
    } else {
      // Check if max-snippet with non-zero value (info only)
      const maxSnippetMatch = directives.find((d) =>
        d.startsWith("max-snippet:")
      );
      if (maxSnippetMatch) {
        checks.push({
          name: "nosnippet",
          status: "info",
          message: `Snippet length limited: ${maxSnippetMatch}`,
          value: robots,
        });
      } else {
        checks.push({
          name: "nosnippet",
          status: "pass",
          message: "No snippet restrictions found",
        });
      }
    }

    return { checks };
  },
};
