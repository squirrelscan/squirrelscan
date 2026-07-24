// integrity/brand-impersonation — page impersonates a third-party brand's
// login/booking surface that isn't backed by that brand's real host.
//
// Correlation-gated (issue #116): a lone brand-impersonation signal emits `info`
// (a single off-brand login control could be a misconfigured embed). It escalates
// to a high-severity `fail` only when >=2 distinct integrity signals corroborate
// on the same page (e.g. impersonation + obfuscated-script, the real kit shape).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  detectBrandImpersonation,
  detectPageSignals,
  shouldEscalate,
} from "./signals";

export const brandImpersonationRule: Rule = {
  meta: {
    id: "integrity/brand-impersonation",
    name: "Brand Impersonation",
    description:
      "Detects pages impersonating a third-party brand's login or booking surface (Calendly, Google/Microsoft login, ClickFunnels, Kajabi, DocuSign) where credentials are sent off-brand",
    solution:
      "A page presenting a third-party brand's sign-in or booking surface whose credential target is NOT that brand's legitimate host is a classic phishing-kit pattern. If you did not create this page, your site is likely compromised: look for recently added files, unexpected pages not in your CMS, and injected PHP/JS. Remove the page, rotate credentials, and review server access logs. A legitimate integration must link to the brand's real domain (e.g. accounts.google.com, calendly.com).",
    category: "integrity",
    scope: "page",
    severity: "warning",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) return { checks };

    const hit = detectBrandImpersonation(ctx);
    if (!hit) {
      return { checks };
    }

    const signals = detectPageSignals(ctx);
    const escalate = shouldEscalate(signals, "brand-impersonation");
    const corroborating = [...signals].filter(
      (s) => s !== "brand-impersonation"
    );

    checks.push({
      name: "brand-impersonation",
      status: escalate ? "fail" : "info",
      message: escalate
        ? `Likely phishing kit impersonating ${hit.brand} (${signals.size} corroborating integrity signals)`
        : `Possible ${hit.brand} brand impersonation (single signal — review)`,
      pageUrl: ctx.page.url,
      value: hit.reason,
      details: {
        brand: hit.brand,
        signals: [...signals],
        corroborating,
        escalated: escalate,
      },
    });

    return { checks };
  },
};
