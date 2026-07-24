// perf/preconnect - Preconnect hints for critical origins

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

export const preconnectRule: Rule = {
  meta: {
    id: "perf/preconnect",
    name: "Preconnect Hints",
    description: "Checks for preconnect hints to critical third-party origins",
    solution:
      "Preconnect establishes early connections to important third-party origins, saving time on DNS lookup, TCP handshake, and TLS negotiation. Add <link rel='preconnect' href='https://example.com'> for CDNs and critical third-party services. Use crossorigin attribute for CORS resources like fonts. Limit preconnects to 2-4 most critical origins to avoid connection congestion.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check for missing preconnect to CDNs
    if (hints.missingPreconnect.length > 0) {
      checks.push({
        name: "preconnect-missing",
        status: "warn",
        message: `Missing preconnect for ${hints.missingPreconnect.length} CDN(s)`,
        items: hints.missingPreconnect.map((url) => ({ id: url })),
      });
    }

    // Report existing resource hints
    if (hints.preconnectTags.length > 0 || hints.dnsPrefetchTags.length > 0) {
      checks.push({
        name: "preconnect-usage",
        status: "pass",
        message: "Resource hints in use",
        details: {
          preconnect: hints.preconnectTags.length,
          dnsPrefetch: hints.dnsPrefetchTags.length,
        },
      });
    } else if (hints.missingPreconnect.length === 0) {
      checks.push({
        name: "preconnect-usage",
        status: "info",
        message: "No preconnect hints (may not be needed)",
      });
    }

    return { checks };
  },
};
