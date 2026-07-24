// eeat/terms-of-service - Terms of service page presence

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { EEAT_PAGE_PATTERNS } from "@squirrelscan/utils/constants";
import { getPathname } from "@squirrelscan/utils";

export const termsOfServiceRule: Rule = {
  meta: {
    id: "eeat/terms-of-service",
    name: "Terms of Service",
    description: "Checks for terms of service page",
    solution:
      "Terms of Service (ToS) define the rules for using your site/service. Essential for: e-commerce, SaaS, membership sites. Include: user responsibilities, intellectual property, disclaimers, dispute resolution. Link from footer. Keep updated when practices change. For simple content sites, may be optional but still recommended.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "terms-of-service",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Multilingual patterns
    const tosPatterns = EEAT_PAGE_PATTERNS.terms;

    let tosPage: string | null = null;

    for (const page of pages) {
      const path = getPathname(page.url);
      if (tosPatterns.some((p) => p.test(path))) {
        tosPage = page.url;
        break;
      }
    }

    if (tosPage) {
      checks.push({
        name: "terms-of-service",
        status: "pass",
        message: "Terms of Service page found",
        value: tosPage,
      });
    } else {
      checks.push({
        name: "terms-of-service",
        status: "info",
        message: "No Terms of Service page found",
        value: "Consider adding for e-commerce/SaaS sites",
      });
    }

    return { checks };
  },
};
