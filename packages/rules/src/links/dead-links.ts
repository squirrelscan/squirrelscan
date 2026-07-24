// links/dead-links - Cloud-verified dead link summary
//
// This rule is the ENABLE GATE for the cloud dead-links service: its
// `meta.cloud` spec opts the audit into routing external link checks through
// the credit-gated /v1/services/dead-links bulk endpoint (shared global
// cache). The check itself is a summary — per-link findings are reported by
// links/broken-external-links; this rule never re-scores them (info only).

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const deadLinksRule: Rule = {
  meta: {
    id: "links/dead-links",
    name: "Dead Links (Cloud)",
    description:
      "Verifies external links through the cloud dead-links service, which shares a global link-check cache across all audits",
    solution:
      "Enable cloud features (`squirrel auth login`) to verify external links against the shared global cache instead of fetching each link locally. Cached results make repeat audits faster and avoid hammering third-party sites. Broken links found here are detailed by links/broken-external-links.",
    category: "links",
    scope: "site",
    severity: "info",
    weight: 1,
    cloud: { service: "dead-links", unit: "link", creditFeature: "dead_links" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const externalLinks = ctx.site?.externalLinks;

    if (!externalLinks) {
      checks.push({
        name: "dead-links",
        status: "skipped",
        message: "No external link check data available",
        skipReason: "External link checking did not run",
      });
      return { checks };
    }

    // Zero external links is a real result, not a locked one (#656): no plan
    // could verify anything here, so the upsell must not advertise this rule.
    if (externalLinks.length === 0) {
      checks.push({
        name: "dead-links",
        status: "info",
        message: "No external links found to verify",
        value: 0,
        expected: 0,
      });
      return { checks };
    }

    const checked = externalLinks.filter((l) => l.status !== null || l.error !== null);
    // Mirror links/broken-external-links: WAF-blocked 403s are not broken.
    const broken = checked.filter((l) => {
      if (l.error) return true;
      if (l.status === 403 && l.wafBlocked) return false;
      if (l.status && l.status >= 400) return true;
      return false;
    });

    checks.push({
      name: "dead-links",
      status: "info",
      message:
        broken.length === 0
          ? `Checked ${checked.length} external link(s); none are dead`
          : `Checked ${checked.length} external link(s); ${broken.length} dead`,
      value: broken.length,
      expected: 0,
    });

    return { checks };
  },
};
