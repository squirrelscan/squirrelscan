// eeat/citations - External citations and source references

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { sitePageViews } from "../shared/site-page-view";

export const citationsRule: Rule = {
  meta: {
    id: "eeat/citations",
    name: "Citations",
    description: "Checks for citations to authoritative external sources",
    solution:
      "Citing authoritative sources builds credibility and supports E-E-A-T. Link to: government sites (.gov), educational institutions (.edu), peer-reviewed research, industry authorities. For health: cite NIH, CDC, WHO, medical journals. Include a sources/references section. Don't cite low-quality or unverified sources.",
    category: "eeat",
    scope: "site",
    findingScope: "page",
    severity: "info",
    weight: 3,
    // Authoritative citations are an E-E-A-T signal for editorial / informational
    // content; a SaaS marketing site or ecommerce store has nothing to cite.
    // Gate to content-publishing types. Offline / no-metadata runs as today.
    appliesWhen: {
      siteTypes: [
        "blog",
        "news",
        "healthcare_provider",
        "education",
        "nonprofit",
      ],
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = sitePageViews(ctx);

    if (!pages || pages.length === 0) {
      checks.push({
        name: "citations",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    let pagesWithAuthoritativeCitations = 0;
    let totalAuthoritativeLinks = 0;

    for (const page of pages) {
      totalAuthoritativeLinks += page.authoritativeLinks;
      if (page.authoritativeLinks > 0) pagesWithAuthoritativeCitations++;
    }

    if (totalAuthoritativeLinks > 0) {
      checks.push({
        name: "citations",
        status: "pass",
        message: `${totalAuthoritativeLinks} authoritative citation(s) found`,
        value: `Across ${pagesWithAuthoritativeCitations} page(s)`,
      });
    } else {
      checks.push({
        name: "citations",
        status: "info",
        message: "No authoritative citations detected",
        value: "Consider citing .gov, .edu, or industry sources",
      });
    }

    return { checks };
  },
};
