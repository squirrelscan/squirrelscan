// legal/privacy-policy - Privacy policy check (site-wide)
//
// Context-aware: when the Stage-0 site profile indicates a GDPR (EU/EEA/UK) or
// CCPA (California / US) jurisdiction, a MISSING privacy policy is escalated from
// a warning to a hard failure — those jurisdictions make it legally mandatory.
// Behaviour is identical when no metadata is resolved (offline / free).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { findPrivacyPage, privacyLinkHref } from "../shared/privacy-page";
import { privacyRegimeLabel } from "./jurisdiction";

export const privacyPolicyRule: Rule = {
  meta: {
    id: "legal/privacy-policy",
    name: "Privacy Policy",
    description: "Checks for privacy policy link presence",
    solution:
      "A privacy policy is legally required in many jurisdictions (GDPR, CCPA). Link to your privacy policy from every page, typically in the footer. The policy should explain what data you collect, how it's used, and user rights. Consider using schema.org markup to identify the policy page.",
    category: "legal",
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

    // Credit a privacy policy when a crawled page IS one (slug OR title/h1) or any
    // page links to one — same acceptance as eeat/privacy-policy so the two
    // categories stay consistent (#1098).
    let privacyUrl = findPrivacyPage(pages) ?? "";
    if (!privacyUrl) {
      for (const page of pages) {
        const href = privacyLinkHref(page);
        if (href) {
          privacyUrl = href;
          break;
        }
      }
    }

    if (privacyUrl) {
      checks.push({
        name: "privacy-policy",
        status: "pass",
        message: "Privacy policy link found",
        value: privacyUrl,
      });
    } else {
      // Escalate when the Stage-0 profile places the site under a stricter
      // privacy regime (GDPR / CCPA) — a missing policy is then legally serious.
      const regime = privacyRegimeLabel(ctx.siteMetadata);
      checks.push({
        name: "privacy-policy",
        status: regime ? "fail" : "warn",
        message: regime
          ? `No privacy policy link found across site — required under ${regime}`
          : "No privacy policy link found across site",
        value: regime
          ? `Add a privacy policy — legally required for your audience (${regime})`
          : "Add a link to your privacy policy",
      });
    }

    return { checks };
  },
};
