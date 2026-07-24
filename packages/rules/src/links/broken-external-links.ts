// links/broken-external-links - Broken external link detection
// Uses cached check results from external link checker

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

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
    // Excludes WAF-blocked 403s since those are not truly broken
    const brokenLinks = externalLinks.filter((link) => {
      if (link.error) return true;
      // WAF-blocked 403s are not truly broken - they're just inaccessible to bots
      if (link.status === 403 && link.wafBlocked) return false;
      if (link.status && link.status >= 400) return true;
      return false;
    });

    // Find WAF-blocked links (status unverifiable)
    const wafBlockedLinks = externalLinks.filter((link) => link.wafBlocked);

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

    return { checks };
  },
};
