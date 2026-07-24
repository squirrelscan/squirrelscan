// analytics/consent-mode - Google Consent Mode check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const consentModeRule: Rule = {
  meta: {
    id: "analytics/consent-mode",
    name: "Consent Mode",
    description: "Checks for Google Consent Mode v2 implementation",
    solution:
      "Google Consent Mode v2 is required for Google Ads in the EU/EEA (March 2024). It allows Google tags to adjust behavior based on user consent. Implement with gtag('consent', 'default', {...}) before loading Google tags. Set ad_storage, analytics_storage, ad_user_data, and ad_personalization. Update on user consent.",
    category: "analytics",
    scope: "page",
    severity: "info",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const html = ctx.page.html;

    // Check for consent mode patterns
    const consentModePatterns = [
      /gtag\s*\(\s*['"]consent['"]/i,
      /consent['"]?\s*:\s*['"]default['"]/i,
      /ad_storage/i,
      /analytics_storage/i,
      /ad_user_data/i,
      /ad_personalization/i,
    ];

    const hasConsentMode = consentModePatterns.some((p) => p.test(html));

    // Check if Google tags are present (making consent mode relevant)
    const hasGoogleTags =
      html.includes("googletagmanager.com") ||
      html.includes("gtag") ||
      html.includes("google-analytics") ||
      html.includes("googlesyndication") ||
      html.includes("googleadservices");

    if (!hasGoogleTags) {
      checks.push({
        name: "consent-mode",
        status: "skipped",
        message: "No Google tags detected (consent mode not applicable)",
      });
      return { checks };
    }

    // Check for Consent Mode v2 specific signals
    const hasV2Signals =
      html.includes("ad_user_data") || html.includes("ad_personalization");

    if (hasConsentMode && hasV2Signals) {
      checks.push({
        name: "consent-mode",
        status: "pass",
        message: "Google Consent Mode v2 detected",
      });
    } else if (hasConsentMode) {
      checks.push({
        name: "consent-mode",
        status: "info",
        message: "Consent Mode detected (may need v2 upgrade)",
        value: "Add ad_user_data and ad_personalization for v2",
      });
    } else {
      checks.push({
        name: "consent-mode",
        status: "info",
        message: "Google Consent Mode not detected",
        value: "Required for EU Google Ads compliance",
      });
    }

    return { checks };
  },
};
