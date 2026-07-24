// security/new-tab - External links with target="_blank" security

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const newTabRule: Rule = {
  meta: {
    id: "security/new-tab",
    name: "External Link Security",
    description:
      "Checks external target=_blank links for noopener (security) and noreferrer (privacy)",
    solution:
      'External links with target="_blank" should include rel="noopener noreferrer". noopener prevents the opened page from accessing window.opener (tab-nabbing attacks). noreferrer prevents leaking the referrer URL to the destination site (privacy). Modern browsers default noopener for target="_blank", but explicit attributes ensure compatibility.',
    category: "security",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const pageUrl = new URL(ctx.page.url);

    const missingNoopener: string[] = [];
    const missingNoreferrer: string[] = [];
    let externalBlankCount = 0;

    const links = doc.querySelectorAll('a[href][target="_blank"]');

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Check if external
      try {
        const linkUrl = new URL(href, ctx.page.url);
        if (linkUrl.hostname === pageUrl.hostname) continue;

        externalBlankCount++;

        const rel = (link.getAttribute("rel") || "").toLowerCase();
        const hasNoopener = rel.includes("noopener");
        const hasNoreferrer = rel.includes("noreferrer");

        if (!hasNoopener) {
          missingNoopener.push(href);
        }
        if (!hasNoreferrer) {
          missingNoreferrer.push(href);
        }
      } catch {
        // Invalid URL, skip
      }
    }

    // noopener check (security)
    if (missingNoopener.length > 0) {
      checks.push({
        name: "noopener",
        status: "warn",
        message: `${missingNoopener.length} external link(s) missing rel="noopener"`,
        items: missingNoopener.map((url) => ({ id: url })),
      });
    } else if (externalBlankCount > 0) {
      checks.push({
        name: "noopener",
        status: "pass",
        message: `${externalBlankCount} external _blank link(s) have noopener`,
      });
    }

    // noreferrer check (privacy)
    if (missingNoreferrer.length > 0) {
      checks.push({
        name: "noreferrer",
        status: "info",
        message: `${missingNoreferrer.length} external link(s) missing rel="noreferrer"`,
        items: missingNoreferrer.map((url) => ({ id: url })),
      });
    } else if (externalBlankCount > 0) {
      checks.push({
        name: "noreferrer",
        status: "pass",
        message: `${externalBlankCount} external _blank link(s) have noreferrer`,
      });
    }

    // No external _blank links
    if (externalBlankCount === 0) {
      checks.push({
        name: "new-tab-security",
        status: "info",
        message: 'No external target="_blank" links found',
      });
    }

    return { checks };
  },
};
