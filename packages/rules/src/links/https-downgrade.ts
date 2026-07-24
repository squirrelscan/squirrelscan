// links/https-downgrade - HTTPS to HTTP downgrade detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const httpsDowngradeRule: Rule = {
  meta: {
    id: "links/https-downgrade",
    name: "HTTPS Downgrade",
    description: "Detects links from HTTPS pages to HTTP destinations",
    solution:
      "Links from HTTPS to HTTP pages create security warnings and break the trust chain. Users may see 'not secure' warnings. Update all links to use HTTPS. If the target site doesn't support HTTPS, consider if you really need to link there. For internal links, ensure your entire site uses HTTPS.",
    category: "links",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const pageUrl = new URL(ctx.page.url);

    // Only check if current page is HTTPS
    if (pageUrl.protocol !== "https:") {
      checks.push({
        name: "https-downgrade",
        status: "info",
        message: "Page is not HTTPS, downgrade check not applicable",
      });
      return { checks };
    }

    const httpLinks: string[] = [];
    const links = doc.querySelectorAll("a[href]");

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Check for explicit http:// links
      if (href.startsWith("http://")) {
        httpLinks.push(href);
      }
    }

    if (httpLinks.length > 0) {
      checks.push({
        name: "https-downgrade",
        status: "warn",
        message: `${httpLinks.length} link(s) downgrade to HTTP`,
        items: httpLinks.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "https-downgrade",
        status: "pass",
        message: "No HTTPS to HTTP downgrades",
      });
    }

    return { checks };
  },
};
