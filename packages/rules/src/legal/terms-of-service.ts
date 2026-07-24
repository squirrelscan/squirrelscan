// legal/terms-of-service - Terms of service check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const termsOfServiceRule: Rule = {
  meta: {
    id: "legal/terms-of-service",
    name: "Terms of Service",
    description: "Checks for terms of service link presence",
    solution:
      "Terms of Service (ToS) protect your business by defining user rights and limitations. Link to ToS from your footer on every page. Essential for: e-commerce sites, SaaS products, user-generated content platforms, and membership sites. Include sections on: usage rules, liability limits, dispute resolution, and termination.",
    category: "legal",
    scope: "page",
    severity: "info",
    weight: 3,
    // A soft-404 error page has no footer/links — don't report a missing ToS
    // link on a broken URL (#1174).
    skipOnSoft404: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Look for terms of service links
    const links = doc.querySelectorAll("a[href]");

    const tosPatterns = [
      /terms[-_]?(of[-_]?)?(service|use)/i,
      /terms[-_]?and[-_]?conditions/i,
      /tos(?:\/|$)/i,
      /\/terms\/?$/i,
      /\/legal\/terms/i,
      /nutzungsbedingungen/i, // German
      /agb(?:\/|$)/i, // German
      /conditions[-_]?g[eé]n[eé]rales/i, // French
      /condiciones/i, // Spanish
    ];

    let hasTermsLink = false;
    let termsUrl = "";

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const text = (link.textContent || "").toLowerCase();

      const hrefMatches = tosPatterns.some((p) => p.test(href));
      const textMatches =
        text.includes("terms of service") ||
        text.includes("terms of use") ||
        text.includes("terms and conditions") ||
        text.includes("terms & conditions") ||
        (text.includes("terms") && text.length < 30);

      if (hrefMatches || textMatches) {
        hasTermsLink = true;
        termsUrl = href;
        break;
      }
    }

    if (hasTermsLink) {
      checks.push({
        name: "terms-of-service",
        status: "pass",
        message: "Terms of service link found",
        value: termsUrl,
      });
    } else {
      checks.push({
        name: "terms-of-service",
        status: "info",
        message: "No terms of service link found",
        value: "Consider adding terms of service for legal protection",
      });
    }

    return { checks };
  },
};
