import { isPageIndexable } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult } from "../types";

export const indexabilityCheck: Rule = {
  meta: {
    id: "crawl/indexability",
    name: "Indexability Check",
    description: "Identifies pages blocked from search engine indexing",
    solution:
      "If this page should be indexed by search engines, remove 'noindex' from robots meta tag or X-Robots-Tag header. If the page is intentionally blocked (e.g., admin pages, thank-you pages), this is expected behavior.",
    category: "crawl",
    scope: "page",
    findingScope: "page",
    verdictScope: "page",
    severity: "info",
    weight: 2,
    // Check names by outcome class (#1741, #2218).
    checks: [
      { name: "indexability", outcome: "problem" },
      { name: "indexability", outcome: "clean", clears: ["indexability"] },
      { name: "indexability", outcome: "skipped" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const { parsed, page } = ctx;

    if (!parsed) {
      return {
        checks: [
          {
            name: "indexability",
            status: "skipped",
            message: "Page could not be parsed",
            skipReason: "Page could not be parsed",
          },
        ],
      };
    }

    const { isIndexable } = isPageIndexable(parsed, page.headers);

    if (!isIndexable) {
      const robotsMeta = parsed.meta?.robots?.toLowerCase() || "";
      const xRobotsTag = page.headers?.["x-robots-tag"]?.toLowerCase() || "";

      const source = robotsMeta.includes("noindex")
        ? "robots meta tag"
        : xRobotsTag.includes("noindex")
          ? "X-Robots-Tag header"
          : "unknown";

      return {
        checks: [
          {
            name: "indexability",
            status: "info",
            message: `Page is blocked from indexing via ${source}`,
            value: "not indexable",
          },
        ],
      };
    }

    return {
      checks: [
        {
          name: "indexability",
          status: "pass",
          message: "Page is indexable",
          value: "indexable",
        },
      ],
    };
  },
};
