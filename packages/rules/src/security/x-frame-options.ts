// security/x-frame-options - Clickjacking protection

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** Trim + uppercase; a header repeated with the same value ("DENY, DENY") collapses to it. */
function normalizeXfo(raw: string): string {
  const parts = raw.split(",").map((p) => p.trim().toUpperCase());
  const first = parts[0] ?? "";
  return parts.every((p) => p === first) ? first : parts.join(", ");
}

/** True when any policy (comma-joined) has a `frame-ancestors` directive name. */
function hasFrameAncestorsDirective(csp: string): boolean {
  return csp
    .split(",")
    .flatMap((policy) => policy.split(";"))
    .some((d) => d.trim().split(/\s+/)[0]?.toLowerCase() === "frame-ancestors");
}

/** Header value safe to echo in a message: no control chars, capped length. */
function printable(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}...` : clean;
}

export const xFrameOptionsRule: Rule = {
  meta: {
    id: "security/x-frame-options",
    name: "X-Frame-Options",
    description: "Checks for clickjacking protection header",
    solution:
      "X-Frame-Options prevents your site from being embedded in iframes, protecting against clickjacking attacks. Set: X-Frame-Options: DENY (no framing) or SAMEORIGIN (same origin only). For modern browsers, CSP frame-ancestors is preferred: Content-Security-Policy: frame-ancestors 'self'. Use both for maximum compatibility.",
    category: "security",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const firstPage = ctx.site?.pages[0];

    if (!firstPage) {
      checks.push({
        name: "x-frame-options",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const xFrameOptions = headers["x-frame-options"];
    const csp = headers["content-security-policy"];
    const hasFrameAncestors = csp ? hasFrameAncestorsDirective(csp) : false;

    if (xFrameOptions) {
      const value = normalizeXfo(xFrameOptions);
      if (value === "DENY" || value === "SAMEORIGIN") {
        checks.push({
          name: "x-frame-options",
          status: "pass",
          message: "X-Frame-Options header present",
          value: xFrameOptions,
        });
      } else if (value.includes("ALLOW-FROM")) {
        checks.push({
          name: "x-frame-options",
          status: "warn",
          message: "ALLOW-FROM is deprecated",
          value: "Use CSP frame-ancestors instead",
        });
      } else if (hasFrameAncestors) {
        checks.push({
          name: "x-frame-options",
          status: "pass",
          message: "Clickjacking protection via CSP frame-ancestors",
        });
      } else {
        checks.push({
          name: "x-frame-options",
          status: "warn",
          message: `Unrecognised X-Frame-Options value: ${printable(xFrameOptions)}`,
          value: "Browsers ignore it. Use DENY or SAMEORIGIN, or CSP frame-ancestors",
        });
      }
    } else if (hasFrameAncestors) {
      checks.push({
        name: "x-frame-options",
        status: "pass",
        message: "Clickjacking protection via CSP frame-ancestors",
      });
    } else {
      checks.push({
        name: "x-frame-options",
        status: "warn",
        message: "No clickjacking protection",
        value: "Add X-Frame-Options: DENY or CSP frame-ancestors",
      });
    }

    return { checks };
  },
};
