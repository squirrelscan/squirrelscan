// security/new-tab - External links with target="_blank" security

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const newTabRule: Rule = {
  meta: {
    id: "security/new-tab",
    name: "External Link Security",
    description:
      'Flags external target=_blank links that explicitly opt in to window.opener (rel="opener" without noopener or noreferrer), and notes missing noreferrer as a privacy choice',
    solution:
      'Modern browsers treat target="_blank" as rel="noopener" unless rel="opener" is set, and noreferrer implies noopener. Remove rel="opener" or add rel="noopener" so the opened page cannot reach window.opener. Add rel="noreferrer" as well if you do not want to send the referrer URL to the destination site (a privacy choice, not a security flaw).',
    category: "security",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const pageUrl = new URL(ctx.page.url);

    const exposedOpener: string[] = [];
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

        // rel is a case-insensitive, whitespace-separated token list.
        const tokens = new Set(
          (link.getAttribute("rel") || "").toLowerCase().split(/\s+/).filter(Boolean),
        );
        const hasNoreferrer = tokens.has("noreferrer");
        // target=_blank implies noopener unless rel=opener is set, and
        // noreferrer implies noopener (HTML Standard, link types).
        const isolated = hasNoreferrer || tokens.has("noopener") || !tokens.has("opener");

        if (!isolated) {
          exposedOpener.push(href);
        }
        if (!hasNoreferrer) {
          missingNoreferrer.push(href);
        }
      } catch {
        // Invalid URL, skip
      }
    }

    // noopener check (security)
    if (exposedOpener.length > 0) {
      checks.push({
        name: "noopener",
        status: "warn",
        message: `${exposedOpener.length} external link(s) set rel="opener" without noopener or noreferrer, so the opened page can reach window.opener`,
        items: exposedOpener.map((url) => ({ id: url })),
      });
    } else if (externalBlankCount > 0) {
      checks.push({
        name: "noopener",
        status: "pass",
        message: `${externalBlankCount} external _blank link(s) do not expose window.opener`,
      });
    }

    // noreferrer check (privacy)
    if (missingNoreferrer.length > 0) {
      checks.push({
        name: "noreferrer",
        status: "info",
        message: `${missingNoreferrer.length} external link(s) send the referrer (add rel="noreferrer" if that is not wanted)`,
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
