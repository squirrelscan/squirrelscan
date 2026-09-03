// links/broken-external-links - Broken external link detection
// Uses cached check results from external link checker

import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/**
 * A link the origin refused to answer because it was throttling us (#1829).
 *
 * `rateLimited` is the persisted verdict from the checker (it alone can see a
 * 503's `Retry-After`); the status test is the belt-and-braces path for rows
 * written before the column existed, and for a cloud bulk result that carried
 * only a status.
 */
function isRateLimitedLink(link: { status: number | null; rateLimited?: boolean }): boolean {
  return link.rateLimited === true || isRateLimitStatus(link.status);
}

export const brokenExternalLinksRule: Rule = {
  meta: {
    id: "links/broken-external-links",
    name: "Broken External Links",
    description: "Detects external links returning 4xx/5xx errors or timeouts",
    solution:
      "Broken external links hurt user experience and credibility. Regularly audit external links using automated tools. Remove or replace broken links with working alternatives. Consider using archived versions (archive.org) if the original content is gone. For important resources, consider hosting your own copies of critical documentation or linking to more stable sources.",
    category: "links",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const externalLinks = ctx.site?.externalLinks;

    if (!externalLinks || externalLinks.length === 0) {
      checks.push({
        name: "broken-external-links",
        status: "pass",
        message: "No external links found to check",
        value: 0,
      });
      return { checks };
    }

    // Find broken external links (4xx, 5xx, or errors)
    // Excludes WAF-blocked 403s and rate-limited targets, neither of which is
    // evidence the link is dead.
    const brokenLinks = externalLinks.filter((link) => {
      if (link.error) return true;
      // WAF-blocked 403s are not truly broken - they're just inaccessible to bots
      if (link.status === 403 && link.wafBlocked) return false;
      // #1829: 429/430 (and a Retry-After 503) mean the host throttled US. The
      // link's real status is unknown, so it is reported below as info rather
      // than counted here. Must precede the >= 400 test, which they satisfy.
      if (isRateLimitedLink(link)) return false;
      if (link.status && link.status >= 400) return true;
      return false;
    });

    // Find WAF-blocked links (status unverifiable)
    const wafBlockedLinks = externalLinks.filter((link) => link.wafBlocked);

    // Same bucket, different cause: throttled targets (#1829).
    const rateLimitedLinks = externalLinks.filter((link) => isRateLimitedLink(link));

    const checkedCount = externalLinks.filter(
      (l) => l.status !== null || l.error !== null
    ).length;

    if (brokenLinks.length === 0) {
      checks.push({
        name: "broken-external-links",
        status: "pass",
        message: `All ${checkedCount} external link(s) are working`,
      });
    } else {
      // Group by status code for better reporting
      const byStatus = new Map<string, typeof brokenLinks>();
      for (const link of brokenLinks) {
        const key = link.error ? "error" : String(link.status);
        const group = byStatus.get(key) ?? [];
        group.push(link);
        byStatus.set(key, group);
      }

      // Create a summary of broken links
      const summaryParts: string[] = [];
      for (const [status, links] of byStatus) {
        if (status === "error") {
          summaryParts.push(`${links.length} failed`);
        } else {
          summaryParts.push(`${links.length} with ${status}`);
        }
      }

      checks.push({
        name: "broken-external-links",
        status: "warn",
        message: `${brokenLinks.length} broken external link(s): ${summaryParts.join(", ")}`,
        items: brokenLinks.map((l) => ({
          id: l.href,
          label: l.error
            ? `${l.href} (Error: ${l.error})`
            : `${l.href} (${l.status})`,
          sourcePages: l.sourcePages,
          meta: { status: l.status, error: l.error },
        })),
        details: {
          totalBroken: brokenLinks.length,
          totalChecked: checkedCount,
        },
      });
    }

    // Report WAF-blocked links as info (not broken, just unverifiable)
    if (wafBlockedLinks.length > 0) {
      checks.push({
        name: "waf-blocked-external-links",
        status: "info",
        message: `${wafBlockedLinks.length} external link(s) blocked by WAF - status unverifiable`,
        items: wafBlockedLinks.map((l) => ({
          id: l.href,
          label: `${l.href} (${l.wafProvider ?? "WAF"})`,
          sourcePages: l.sourcePages,
          meta: { wafProvider: l.wafProvider },
        })),
      });
    }

    // Report rate-limited links as info (not broken, just unverifiable),
    // mirroring the WAF bucket above (#1829).
    if (rateLimitedLinks.length > 0) {
      checks.push({
        name: "rate-limited-external-links",
        status: "info",
        message: `${rateLimitedLinks.length} external link(s) rate-limited - status unverifiable`,
        items: rateLimitedLinks.map((l) => ({
          id: l.href,
          label: `${l.href} (${l.status ?? "rate limited"})`,
          sourcePages: l.sourcePages,
          meta: { status: l.status, rateLimited: true },
        })),
      });
    }

    return { checks };
  },
};
