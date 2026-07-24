// security/csp - Content Security Policy header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

// Key CSP directives that should be present for XSS protection
const _CRITICAL_DIRECTIVES = ["default-src", "script-src"];
const _RECOMMENDED_DIRECTIVES = [
  "style-src",
  "img-src",
  "frame-ancestors",
  "object-src",
];

// Overly permissive values that weaken CSP
const WEAK_VALUES = ["*", "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'"];

export const cspRule: Rule = {
  meta: {
    id: "security/csp",
    name: "Content Security Policy",
    description:
      "Checks for Content-Security-Policy header and validates directives",
    solution:
      "CSP prevents XSS attacks by restricting which resources can load. Start with a report-only policy to identify issues. Key directives: default-src 'self', script-src (avoid 'unsafe-inline'), img-src, style-src, frame-ancestors. Use nonces or hashes instead of 'unsafe-inline' for scripts. Test thoroughly as strict CSP can break functionality.",
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const firstPage = ctx.site?.pages[0];

    if (!firstPage) {
      checks.push({
        name: "csp",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const csp = headers["content-security-policy"];
    const cspReportOnly = headers["content-security-policy-report-only"];

    // No CSP at all - this is a warning now, not just info
    if (!csp && !cspReportOnly) {
      checks.push({
        name: "csp-missing",
        status: "warn",
        message: "No Content-Security-Policy header",
        value: "Site vulnerable to XSS without CSP",
        expected: "Content-Security-Policy header with script-src directive",
      });
      return { checks };
    }

    const policy = csp || cspReportOnly || "";
    const isReportOnly = !csp && !!cspReportOnly;

    // Parse directives
    const directives = parseCSP(policy);

    // Report-only mode
    if (isReportOnly) {
      checks.push({
        name: "csp-report-only",
        status: "warn",
        message: "CSP in report-only mode (not enforced)",
        value: "Policy violations are logged but not blocked",
        expected: "Use Content-Security-Policy to enforce",
      });
    } else {
      checks.push({
        name: "csp-present",
        status: "pass",
        message: "CSP header present and enforced",
        value: policy.substring(0, 100) + (policy.length > 100 ? "..." : ""),
      });
    }

    // Check for critical directives
    const hasDefaultSrc = directives.has("default-src");
    const hasScriptSrc = directives.has("script-src");

    if (!hasDefaultSrc && !hasScriptSrc) {
      checks.push({
        name: "csp-no-script-control",
        status: "warn",
        message: "CSP has no script-src or default-src directive",
        value: "Scripts from any source are allowed",
        expected: "Add script-src or default-src directive",
      });
    }

    // Check for unsafe values in script-src
    const scriptSrc =
      directives.get("script-src") || directives.get("default-src") || "";
    const weakValues = WEAK_VALUES.filter((v) => scriptSrc.includes(v));

    if (weakValues.length > 0) {
      // unsafe-inline and unsafe-eval are critical weaknesses
      const hasUnsafeInline = weakValues.includes("'unsafe-inline'");
      const hasUnsafeEval = weakValues.includes("'unsafe-eval'");

      if (hasUnsafeInline || hasUnsafeEval) {
        checks.push({
          name: "csp-unsafe-scripts",
          status: "warn",
          message: `CSP allows ${[hasUnsafeInline && "'unsafe-inline'", hasUnsafeEval && "'unsafe-eval'"].filter(Boolean).join(" and ")}`,
          value: "Weakens XSS protection significantly",
          expected: "Use nonces or hashes instead of unsafe-inline",
        });
      }

      // Wildcard is also problematic
      if (weakValues.includes("*")) {
        checks.push({
          name: "csp-wildcard",
          status: "warn",
          message: "CSP script-src allows wildcard (*)",
          value: "Scripts can load from any domain",
          expected: "Restrict to specific trusted domains",
        });
      }
    }

    // Check for frame-ancestors (clickjacking protection)
    if (!directives.has("frame-ancestors")) {
      const xfo = headers["x-frame-options"];
      if (!xfo) {
        checks.push({
          name: "csp-no-frame-ancestors",
          status: "info",
          message: "CSP missing frame-ancestors directive",
          value: "Consider adding for clickjacking protection",
        });
      }
    }

    // Check for object-src (plugin-based attacks)
    if (!directives.has("object-src") && !hasDefaultSrc) {
      checks.push({
        name: "csp-no-object-src",
        status: "info",
        message: "CSP missing object-src directive",
        value: "Consider blocking plugins with object-src 'none'",
      });
    }

    return { checks };
  },
};

/**
 * Parse CSP header into directive map
 */
function parseCSP(policy: string): Map<string, string> {
  const directives = new Map<string, string>();

  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      directives.set(trimmed.toLowerCase(), "");
    } else {
      const name = trimmed.substring(0, spaceIdx).toLowerCase();
      const value = trimmed.substring(spaceIdx + 1);
      directives.set(name, value);
    }
  }

  return directives;
}
