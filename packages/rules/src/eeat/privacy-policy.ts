// eeat/privacy-policy - Privacy policy page presence

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { findPrivacyPage, pageLinksToPrivacyHref } from "../shared/privacy-page";

export const privacyPolicyRule: Rule = {
  meta: {
    id: "eeat/privacy-policy",
    name: "Privacy Policy",
    description: "Checks for privacy policy page linked from footer",
    solution:
      "A privacy policy is required by law in many jurisdictions (GDPR, CCPA) and signals trustworthiness. Link it from your footer on every page. Cover: what data you collect, how you use it, third-party sharing, user rights, and contact for privacy concerns. Keep it updated when practices change.",
    category: "eeat",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const pages = ctx.site?.pages;

    if (!pages || pages.length === 0) {
      checks.push({
        name: "privacy-policy",
        status: "skipped",
        message: "No pages available for analysis",
      });
      return { checks };
    }

    // Look for a privacy policy page: known slug (multilingual) OR a crawled page
    // whose title/h1 reads "privacy policy" — the slug-independent fallback that
    // catches redirects/unusual slugs (#1098). Unlike about/contact, there is no
    // standard Schema.org @type for privacy pages, so no schema fallback (#121).
    let linkedFromPages = 0;
    const privacyPage = findPrivacyPage(pages);

    if (!privacyPage) {
      checks.push({
        name: "privacy-policy",
        status: "warn",
        message: "No Privacy Policy page found",
        value: "Create /privacy-policy page",
      });
      return { checks };
    }

    checks.push({
      name: "privacy-policy",
      status: "pass",
      message: "Privacy Policy page exists",
      value: privacyPage,
    });

    // Check how many pages link to it (href-slug only — the original metric, not
    // widened by anchor-text matching which belongs to the legal rule).
    for (const page of pages) {
      if (pageLinksToPrivacyHref(page)) linkedFromPages++;
    }

    const linkPercentage = Math.round((linkedFromPages / pages.length) * 100);

    if (linkPercentage >= 80) {
      checks.push({
        name: "privacy-linked",
        status: "pass",
        message: `Privacy policy linked from ${linkPercentage}% of pages`,
      });
    } else if (linkPercentage >= 50) {
      checks.push({
        name: "privacy-linked",
        status: "info",
        message: `Privacy policy linked from ${linkPercentage}% of pages`,
        value: "Consider adding to all page footers",
      });
    } else {
      checks.push({
        name: "privacy-linked",
        status: "warn",
        message: `Privacy policy only linked from ${linkPercentage}% of pages`,
        value: "Add privacy link to footer on all pages",
      });
    }

    return { checks };
  },
};
