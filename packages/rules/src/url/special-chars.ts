// url/special-chars - URL special character check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const specialCharsRule: Rule = {
  meta: {
    id: "url/special-chars",
    name: "URL Special Characters",
    description: "Checks for problematic special characters in URL path",
    solution:
      "Avoid special characters in URL paths. Characters like %, &, #, ?, = have special meanings and can cause issues. Spaces should be avoided (they become %20). Use only lowercase letters, numbers, and hyphens. Special characters can break links when copied, cause encoding issues, and look unprofessional. URL-encode if unavoidable.",
    category: "url",
    scope: "page",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = decodeURIComponent(url.pathname);

    // Check for problematic characters in path
    const problematicChars = /[%&=#[\]{}|\\^~`<>]/;
    const hasSpaces = /%20|\s/.test(url.pathname) || path.includes(" ");
    const hasSpecialChars = problematicChars.test(path);

    // Check for non-ASCII characters (outside printable ASCII range)
    const hasNonAscii = /[^\x20-\x7E]/.test(path);

    const issues: string[] = [];

    if (hasSpaces) {
      issues.push("spaces");
    }
    if (hasSpecialChars) {
      issues.push("special characters");
    }
    if (hasNonAscii) {
      issues.push("non-ASCII characters");
    }

    if (issues.length > 0) {
      checks.push({
        name: "url-special-chars",
        status: "warn",
        message: `URL path contains problematic characters`,
        items: issues.map((issue) => ({ id: issue })),
        details: { path },
      });
    } else {
      checks.push({
        name: "url-special-chars",
        status: "pass",
        message: "URL path uses clean characters",
      });
    }

    // Check for double slashes in path
    if (/\/\//.test(path.substring(1))) {
      checks.push({
        name: "url-double-slash",
        status: "warn",
        message: "URL path contains double slashes",
        value: path,
      });
    }

    return { checks };
  },
};
