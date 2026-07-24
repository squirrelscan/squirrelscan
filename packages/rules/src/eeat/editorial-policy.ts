// eeat/editorial-policy - Editorial and content policy pages

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

export const editorialPolicyRule: Rule = {
  meta: {
    id: "eeat/editorial-policy",
    name: "Editorial Policy",
    description: "Checks for editorial and content policy pages",
    solution:
      "Editorial policies demonstrate content quality standards and professionalism. Include: how content is created/reviewed, fact-checking process, correction policy, and editorial independence. For news sites, this is essential. For content sites, it builds trust and supports E-E-A-T. Link from footer or about page.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 3,
    // Editorial / fact-checking policies are an authority signal for news and
    // content publishers; noise for SaaS / ecommerce / portfolios. Gate to
    // editorial site types. Offline / no-metadata runs as today.
    appliesWhen: { siteTypes: ["news", "blog", "healthcare_provider", "education"] },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "editorial-policy",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Multilingual patterns
    const policyPatterns = EEAT_PAGE_PATTERNS.editorial;

    const foundPolicies: string[] = [];

    for (const page of pages) {
      const path = getPathname(page.url);
      if (policyPatterns.some((p) => p.test(path))) {
        foundPolicies.push(path);
      }
    }

    if (foundPolicies.length > 0) {
      checks.push({
        name: "editorial-policy",
        status: "pass",
        message: `${foundPolicies.length} policy page(s) found`,
        items: foundPolicies.map((path) => ({ id: path })),
      });
    } else {
      checks.push({
        name: "editorial-policy",
        status: "info",
        message: "No editorial/content policy pages found",
        value: "Consider adding for content-heavy sites",
      });
    }

    return { checks };
  },
};
