// core/canonical-header - Validates Link header canonical matches HTML canonical

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Parse Link header for canonical URL
// Format: Link: <https://example.com/page>; rel="canonical"
function parseLinkHeaderCanonical(
  linkHeader: string | undefined
): string | null {
  if (!linkHeader) return null;

  // Link headers can have multiple values separated by commas
  const links = linkHeader.split(",");

  for (const link of links) {
    // Match <url>; rel="canonical"
    const match = link.match(/<([^>]+)>\s*;\s*rel\s*=\s*["']?canonical["']?/i);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

// Normalize URL for comparison (remove trailing slash, fragments)
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = ""; // Remove fragment
    let normalized = parsed.toString();
    // Remove trailing slash (except for root)
    if (
      normalized.endsWith("/") &&
      normalized.length > parsed.origin.length + 1
    ) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export const canonicalHeaderRule: Rule = {
  meta: {
    id: "core/canonical-header",
    name: "Canonical Header Validation",
    description: "Detects mismatch between HTML canonical tag and Link header",
    solution: `When both HTML canonical tag and HTTP Link header are present, they must match. Search engines may get confused by conflicting signals.

HTML: <link rel="canonical" href="https://example.com/page">
HTTP: Link: <https://example.com/page>; rel="canonical"

Best practice: Use HTML canonical tag only. Only add Link header if unable to modify HTML (e.g., PDF files).`,
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // Get HTML canonical from parsed meta
    const htmlCanonical = ctx.parsed.meta.canonical?.trim();

    // Parse Link header for canonical
    const linkHeader = ctx.page.headers["link"];
    const headerCanonical = parseLinkHeaderCanonical(linkHeader);

    // No header canonical = skip check
    if (!headerCanonical) {
      checks.push({
        name: "canonical-header",
        status: "skipped",
        message: "No Link header canonical found",
        skipReason: "Page has no HTTP Link canonical header",
      });
      return { checks };
    }

    // No HTML canonical = info (header-only is valid)
    if (!htmlCanonical) {
      checks.push({
        name: "canonical-header",
        status: "info",
        message: "Canonical only in Link header (no HTML tag)",
        value: headerCanonical,
      });
      return { checks };
    }

    // Both present - must match
    const htmlNormalized = normalizeUrl(htmlCanonical);
    const headerNormalized = normalizeUrl(headerCanonical);

    if (htmlNormalized === headerNormalized) {
      checks.push({
        name: "canonical-header",
        status: "pass",
        message: "HTML canonical matches Link header",
        value: htmlCanonical,
      });
    } else {
      checks.push({
        name: "canonical-header",
        status: "fail",
        message: "Canonical mismatch between HTML and Link header",
        value: `HTML: ${htmlCanonical}, Header: ${headerCanonical}`,
        expected: "Both should match",
      });
    }

    return { checks };
  },
};
