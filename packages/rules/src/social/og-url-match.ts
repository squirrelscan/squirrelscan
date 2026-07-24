// social/og-url-match - og:url matches canonical

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const ogUrlMatchRule: Rule = {
  meta: {
    id: "social/og-url-match",
    name: "OG URL Match",
    description: "Checks that og:url matches canonical URL",
    solution:
      "og:url should match your canonical URL. Mismatches can cause social share stats to be fragmented across different URLs. Use the same URL normalization (https, www, trailing slash) as your canonical tag. Facebook uses og:url for share counting and deduplication.",
    category: "social",
    scope: "page",
    severity: "warning",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };

    const ogUrl = doc.querySelector('meta[property="og:url"]');
    const canonical = doc.querySelector('link[rel="canonical"]');

    if (!ogUrl) {
      checks.push({
        name: "og-url-match",
        status: "info",
        message: "No og:url tag found",
      });
      return { checks };
    }

    const ogUrlValue = ogUrl.getAttribute("content");
    const canonicalValue = canonical?.getAttribute("href");

    if (!canonicalValue) {
      checks.push({
        name: "og-url-match",
        status: "info",
        message: "No canonical to compare og:url against",
      });
      return { checks };
    }

    // Normalize for comparison
    const normalizeUrl = (url: string): string => {
      try {
        const parsed = new URL(url, ctx.page.url);
        return parsed.href.replace(/\/$/, "");
      } catch {
        return url.replace(/\/$/, "");
      }
    };

    const normalizedOg = normalizeUrl(ogUrlValue || "");
    const normalizedCanonical = normalizeUrl(canonicalValue);

    if (normalizedOg === normalizedCanonical) {
      checks.push({
        name: "og-url-match",
        status: "pass",
        message: "og:url matches canonical URL",
      });
    } else {
      checks.push({
        name: "og-url-match",
        status: "warn",
        message: "og:url does not match canonical URL",
        value: `og: ${ogUrlValue}`,
        expected: canonicalValue,
      });
    }

    return { checks };
  },
};
