// security/hsts - HTTP Strict Transport Security header

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const hstsRule: Rule = {
  meta: {
    id: "security/hsts",
    name: "HSTS Header",
    description: "Checks for HTTP Strict Transport Security header",
    solution:
      "HSTS forces browsers to only connect via HTTPS, preventing downgrade attacks. Add the header: Strict-Transport-Security: max-age=31536000; includeSubDomains. Start with a short max-age (1 day) to test, then increase to 1 year. The includeSubDomains directive protects all subdomains. Consider preloading via hstspreload.org for maximum protection.",
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
        name: "hsts",
        status: "skipped",
        message: "No pages to check",
        skipReason: "No pages crawled",
      });
      return { checks };
    }

    const headers = firstPage.headers ?? {};
    const hsts = headers["strict-transport-security"];
    const isHttps = firstPage.url.startsWith("https://");

    if (!isHttps) {
      checks.push({
        name: "hsts",
        status: "info",
        message: "HSTS not applicable - site not served over HTTPS",
      });
      return { checks };
    }

    if (!hsts) {
      checks.push({
        name: "hsts",
        status: "warn",
        message: "Missing Strict-Transport-Security header",
        value: "Add: Strict-Transport-Security: max-age=31536000",
      });
      return { checks };
    }

    // Check max-age
    const maxAgeMatch = hsts.match(/max-age=(\d+)/i);

    // Header present but no valid max-age — it's inert and likely a config bug.
    if (!maxAgeMatch) {
      checks.push({
        name: "hsts",
        status: "warn",
        message: "Malformed HSTS header — no valid max-age directive",
        value: hsts,
        expected: "Strict-Transport-Security: max-age=31536000; includeSubDomains",
      });
      return { checks };
    }

    const maxAge = parseInt(maxAgeMatch[1], 10);

    // max-age=0 actively disables HSTS (not merely short) — flag separately (squirrelscan/squirrelscan#20).
    if (maxAge === 0) {
      checks.push({
        name: "hsts",
        status: "warn",
        message: "HSTS disabled — max-age=0 tells browsers to stop enforcing HTTPS",
        value: hsts,
        expected: "max-age of at least 6 months (15768000 seconds)",
      });
      return { checks };
    }

    const sixMonths = 15768000; // 6 months in seconds
    if (maxAge < sixMonths) {
      checks.push({
        name: "hsts",
        status: "warn",
        message: `HSTS max-age too short (${Math.round(maxAge / 86400)} days)`,
        value: hsts,
        expected: "min 6 months (15768000 seconds)",
      });
    } else {
      checks.push({
        name: "hsts",
        status: "pass",
        message: "HSTS configured correctly",
        value: hsts,
      });
    }

    return { checks };
  },
};
