// a11y/identical-links-same-purpose - Identical links go to same destination

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const identicalLinksSamePurposeRule: Rule = {
  meta: {
    id: "a11y/identical-links-same-purpose",
    name: "Identical Links Same Purpose",
    description:
      "Checks that links with identical text go to the same destination",
    solution:
      "Links with the same visible text should go to the same URL. When identical link text leads to different destinations, it confuses screen reader users who navigate by listing links. Make link text unique or more descriptive to differentiate destinations.",
    category: "a11y",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const links = doc.querySelectorAll("a[href]");
    const linksByText = new Map<string, Set<string>>();

    for (const link of links) {
      const text = link.textContent?.trim().toLowerCase();
      const href = link.getAttribute("href");

      if (!text || !href) continue;
      if (text.length < 2) continue; // Skip very short text like "1", "2"
      if (href.startsWith("#")) continue; // Skip anchor links

      // Normalize href for comparison
      let normalizedHref = href.toLowerCase();
      // Remove trailing slashes for comparison
      normalizedHref = normalizedHref.replace(/\/+$/, "");
      // Remove query strings for basic comparison
      const baseHref = normalizedHref.split("?")[0];

      if (!linksByText.has(text)) {
        linksByText.set(text, new Set());
      }
      linksByText.get(text)?.add(baseHref);
    }

    const inconsistentLinks: string[] = [];

    for (const [text, hrefs] of linksByText) {
      if (hrefs.size > 1) {
        // Same text, different destinations
        const destinations = Array.from(hrefs);
        inconsistentLinks.push(
          `"${text}" → ${destinations.length} different URLs`
        );
      }
    }

    if (inconsistentLinks.length > 0) {
      checks.push({
        name: "identical-links-same-purpose",
        status: "warn",
        message: `${inconsistentLinks.length} link text(s) lead to different destinations`,
        items: inconsistentLinks.slice(0, 10).map((id) => ({ id })),
        details: {
          suggestion: "Make link text unique to differentiate destinations",
        },
      });
    } else if (links.length > 0) {
      checks.push({
        name: "identical-links-same-purpose",
        status: "pass",
        message: "Identical link texts go to same destinations",
      });
    } else {
      checks.push({
        name: "identical-links-same-purpose",
        status: "info",
        message: "No links found",
      });
    }

    return { checks };
  },
};
