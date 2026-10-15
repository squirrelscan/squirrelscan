// links/dead-links - Cloud-verified dead link summary
//
// This rule is the ENABLE GATE for the cloud dead-links service: its
// `meta.cloud` spec opts the audit into routing external link checks through
// the credit-gated /v1/services/dead-links bulk endpoint (shared global
// cache). The check itself is a summary — per-link findings are reported by
// links/broken-external-links; this rule never re-scores them (info only).

import { EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON } from "@squirrelscan/core-contracts";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

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

    // External link checking was off for this audit (repo#2729). A paid run
    // would skip it the same way, so it stays off the locked upsell; the
    // report's "Not checked" note says how to turn checking on.
    if (!externalLinks) {
      checks.push({
        name: "dead-links",
        status: "skipped",
        message: "External link checking was off for this audit, so external links were not verified",
        skipReason: EXTERNAL_LINKS_NOT_CHECKED_SKIP_REASON,
      });
      return { checks };
    }

    // Zero external links is a real result, not a locked one (#656): no plan
    // could verify anything here, so the upsell must not advertise this rule.
    // repo#2759: links that look like actions or carry a token are never sent.
    const linkCheck = ctx.site?.externalLinkCheck;
    const notRequested = linkCheck?.notRequested ?? 0;
    if (externalLinks.length === 0 && linkCheck && notRequested > 0 && notRequested >= linkCheck.found) {
      checks.push({
        name: "dead-links",
        status: "info",
        message: `No external links were verified: all ${notRequested} look like actions or carry a token, so they were not requested`,
        value: 0,
        expected: 0,
      });
      return { checks };
    }

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
    // Mirror links/broken-external-links: unverifiable (a wall, a timeout,
    // pub#800) and rate-limited targets are not broken (#1829).
    const rateLimited = checked.filter(
      (l) => l.rateLimited === true || isRateLimitStatus(l.status),
    );
    const rateLimitedSet = new Set(rateLimited.map((l) => l.href));
    const broken = checked.filter((l) => {
      if (l.error) return true;
      if (l.wafBlocked) return false;
      if (rateLimitedSet.has(l.href)) return false;
      if (l.status && l.status >= 400) return true;
      return false;
    });

    const rateLimitedNote =
      rateLimited.length === 0 ? "" : `; ${rateLimited.length} rate-limited (status unverifiable)`;

    checks.push({
      name: "dead-links",
      status: "info",
      message:
        broken.length === 0
          ? `Checked ${checked.length} external link(s); none are dead${rateLimitedNote}`
          : `Checked ${checked.length} external link(s); ${broken.length} dead${rateLimitedNote}`,
      value: broken.length,
      expected: 0,
    });

    return { checks };
  },
};
