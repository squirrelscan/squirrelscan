// security/hsts - HTTP Strict Transport Security header

import { judgedPage, namingPage } from "./judged-page";
import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

const baseHstsRule: Rule = {
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
    // Check names by outcome class (#1741).
    checks: [
      { name: "hsts-missing", outcome: "problem" },
      { name: "hsts-malformed", outcome: "problem" },
      { name: "hsts-disabled", outcome: "problem" },
      { name: "hsts-max-age-short", outcome: "problem" },
      { name: "hsts", outcome: "clean", clears: ["hsts-missing", "hsts-malformed", "hsts-disabled", "hsts-max-age-short"] },
      { name: "hsts-no-pages", outcome: "skipped" },
      { name: "hsts-not-applicable", outcome: "skipped" },
    ],
    // A dev server or private-network host is not the delivery edge (pub#629).
    skipOnPrivateTarget: true,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const firstPage = judgedPage(ctx.site?.pages);

    if (!firstPage) {
      checks.push({
        name: "hsts-no-pages",
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
        name: "hsts-not-applicable",
        status: "info",
        message: "HSTS not applicable - site not served over HTTPS",
      });
      return { checks };
    }

    if (!hsts) {
      checks.push({
        name: "hsts-missing",
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
        name: "hsts-malformed",
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
        name: "hsts-disabled",
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
        name: "hsts-max-age-short",
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

/** The header rule, with each finding naming the page the header was read from (#1778). */
export const hstsRule: Rule = {
  ...baseHstsRule,
  run(ctx: RuleContext): RuleResult {
    const out = baseHstsRule.run(ctx) as RuleResult;
    const page = judgedPage(ctx.site?.pages);
    return page ? { ...out, checks: namingPage(out.checks, page.url) } : out;
  },
};
