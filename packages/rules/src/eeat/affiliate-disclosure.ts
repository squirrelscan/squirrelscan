// eeat/affiliate-disclosure - Affiliate and sponsored content disclosure

import { getPathname } from "@squirrelscan/utils";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { sitePageViews } from "../shared/site-page-view";

export const affiliateDisclosureRule: Rule = {
  meta: {
    id: "eeat/affiliate-disclosure",
    name: "Affiliate Disclosure",
    description: "Checks for affiliate and sponsored content disclosures",
    solution:
      "FTC requires clear disclosure of affiliate relationships and sponsored content. Disclose at the top of pages with affiliate links, not just in footer. Use clear language: 'We earn commissions from purchases' or 'This post is sponsored.' Create a dedicated disclosure page and link to it. Failure to disclose can result in penalties.",
    category: "eeat",
    scope: "site",
    findingScope: "page",
    severity: "info",
    weight: 4,
    // Affiliate / sponsored-content disclosure (FTC) applies to monetised content
    // publishers — blogs, news, review sites. A SaaS / corporate / ecommerce-own
    // store has no affiliate relationships to disclose. Gate to content types;
    // offline / no-metadata runs as today.
    appliesWhen: { siteTypes: ["blog", "news"] },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = sitePageViews(ctx);

    if (!pages || pages.length === 0) {
      checks.push({
        name: "affiliate-disclosure",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Check for disclosure page
    const disclosurePatterns = [
      /\/disclosure\/?$/i,
      /\/affiliate-disclosure\/?$/i,
      /\/advertising-disclosure\/?$/i,
      /\/sponsored-disclosure\/?$/i,
      /\/ftc-disclosure\/?$/i,
    ];

    let disclosurePage: string | null = null;

    for (const page of pages) {
      const path = getPathname(page.url);
      if (disclosurePatterns.some((p) => p.test(path))) {
        disclosurePage = page.url;
        break;
      }
    }

    // Check for affiliate links
    let pagesWithAffiliateLinks = 0;
    for (const page of pages) {
      if (page.affiliateLink) pagesWithAffiliateLinks++;
    }

    if (pagesWithAffiliateLinks > 0) {
      checks.push({
        name: "affiliate-links",
        status: "info",
        message: `${pagesWithAffiliateLinks} page(s) appear to have affiliate links`,
      });

      if (disclosurePage) {
        checks.push({
          name: "affiliate-disclosure",
          status: "pass",
          message: "Affiliate disclosure page found",
          value: disclosurePage,
        });
      } else {
        checks.push({
          name: "affiliate-disclosure",
          status: "warn",
          message: "Affiliate links detected but no disclosure page found",
          value: "Create /affiliate-disclosure page (FTC requirement)",
        });
      }
    } else if (disclosurePage) {
      checks.push({
        name: "affiliate-disclosure",
        status: "pass",
        message: "Disclosure page exists",
        value: disclosurePage,
      });
    } else {
      checks.push({
        name: "affiliate-disclosure",
        status: "info",
        message: "No affiliate links or disclosure page detected",
      });
    }

    return { checks };
  },
};
