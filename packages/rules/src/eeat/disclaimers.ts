// eeat/disclaimers - Checks for required disclaimers on YMYL content

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const disclaimersRule: Rule = {
  meta: {
    id: "eeat/disclaimers",
    name: "Disclaimers",
    description: "Checks for appropriate disclaimers on sensitive content",
    solution:
      "Disclaimers protect you legally and build trust. Health content: 'This is not medical advice. Consult a healthcare professional.' Finance: 'Not financial advice. Consult a financial advisor.' Legal: 'Not legal advice. Consult an attorney.' Affiliate: 'We may earn commissions.' Make disclaimers visible, not hidden in fine print.",
    category: "eeat",
    scope: "site",
    severity: "info",
    weight: 4,
    // Medical / financial / legal disclaimers only matter for YMYL sites. Gate to
    // YMYL; everywhere else (and offline / no-metadata) the check would be noise.
    appliesWhen: { requiresYMYL: true },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "disclaimers",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for disclaimer pages/sections
    const disclaimerPatterns = [
      /\/disclaimer\/?$/i,
      /\/legal-disclaimer\/?$/i,
      /\/medical-disclaimer\/?$/i,
      /\/affiliate-disclosure\/?$/i,
      /\/advertising-disclosure\/?$/i,
    ];

    let disclaimerPage: string | null = null;

    for (const page of pages) {
      const path = getPathname(page.url);
      if (disclaimerPatterns.some((p) => p.test(path))) {
        disclaimerPage = page.url;
        break;
      }
    }

    if (disclaimerPage) {
      checks.push({
        name: "disclaimer-page",
        status: "pass",
        message: "Disclaimer page found",
        value: disclaimerPage,
      });
    } else {
      checks.push({
        name: "disclaimer-page",
        status: "info",
        message: "No dedicated disclaimer page found",
        value: "Consider adding if you have YMYL or affiliate content",
      });
    }

    return { checks };
  },
};
