// links/nofollow-internal - Internal links with nofollow

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const nofollowInternalRule: Rule = {
  meta: {
    id: "links/nofollow-internal",
    name: "Nofollow Internal",
    description: "Flags internal links with rel=nofollow",
    solution:
      "Nofollow on internal links wastes PageRank and is generally bad practice. Internal links should flow link equity freely throughout your site. Remove nofollow from internal links unless you have a specific reason (e.g., user-generated content links). Use nofollow for external links you don't endorse.",
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

    const nofollowInternal: string[] = [];

    const links = doc.querySelectorAll("a[href][rel]");

    for (const link of links) {
      const href = link.getAttribute("href");
      const rel = link.getAttribute("rel") || "";

      if (!href) continue;

      // Check if nofollow
      const hasNofollow = rel.toLowerCase().includes("nofollow");
      if (!hasNofollow) continue;

      // Check if internal
      try {
        const linkUrl = new URL(href, ctx.page.url);
        if (linkUrl.hostname === pageUrl.hostname) {
          nofollowInternal.push(href);
        }
      } catch {
        // Invalid URL
      }
    }

    if (nofollowInternal.length > 0) {
      checks.push({
        name: "nofollow-internal",
        status: "warn",
        message: `${nofollowInternal.length} internal link(s) have nofollow`,
        items: nofollowInternal.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "nofollow-internal",
        status: "pass",
        message: "No internal links with nofollow",
      });
    }

    return { checks };
  },
};
