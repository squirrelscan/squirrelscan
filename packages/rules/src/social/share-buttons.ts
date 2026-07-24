// social/share-buttons - Social share buttons detection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const shareButtonsRule: Rule = {
  meta: {
    id: "social/share-buttons",
    name: "Share Buttons",
    description: "Checks for social sharing buttons on content pages",
    solution:
      "Social share buttons encourage content sharing and can drive traffic. Place them prominently on blog posts, articles, and shareable content. Include major platforms: Facebook, Twitter/X, LinkedIn. Consider sticky share bars for long content. Avoid too many buttons - 3-4 is optimal.",
    category: "social",
    scope: "page",
    severity: "info",
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    // Check for common share button patterns
    const sharePatterns = [
      /share.*facebook|facebook.*share/i,
      /share.*twitter|twitter.*share/i,
      /share.*linkedin|linkedin.*share/i,
      /addthis|addtoany|shareaholic|sumo-share/i,
    ];

    const html = ctx.page.html.toLowerCase();
    const hasShareButtons = sharePatterns.some((p) => p.test(html));

    // Check for share URLs
    const shareUrls = [
      "facebook.com/sharer",
      "twitter.com/intent/tweet",
      "linkedin.com/share",
    ];

    const links = doc.querySelectorAll("a[href]");
    let shareLinksFound = 0;

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (shareUrls.some((u) => href.includes(u))) {
        shareLinksFound++;
      }
    }

    if (hasShareButtons || shareLinksFound > 0) {
      checks.push({
        name: "share-buttons",
        status: "pass",
        message: "Social share functionality detected",
        value:
          shareLinksFound > 0 ? `${shareLinksFound} share link(s)` : undefined,
      });
    } else {
      // Only suggest for content pages
      const isContentPage = /\/(blog|article|post|news)/i.test(ctx.page.url);
      if (isContentPage) {
        checks.push({
          name: "share-buttons",
          status: "info",
          message: "No share buttons on content page",
          value: "Consider adding for better engagement",
        });
      } else {
        checks.push({
          name: "share-buttons",
          status: "info",
          message: "No social share buttons detected",
        });
      }
    }

    return { checks };
  },
};
