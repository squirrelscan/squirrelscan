// url/trailing-slash - Trailing slash consistency check

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

export const trailingSlashRule: Rule = {
  meta: {
    id: "url/trailing-slash",
    name: "Trailing Slash",
    description: "Checks for consistent trailing slash usage",
    solution:
      "Be consistent with trailing slashes across your site. /page and /page/ are technically different URLs. Pick one convention and stick to it. Configure your server to redirect one to the other. Most sites use trailing slashes for directories and no trailing slash for files. Use canonical tags to specify the preferred version.",
    category: "url",
    scope: "page",
    severity: "info",
    weight: 3,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const url = new URL(ctx.page.url);
    const path = url.pathname;

    // Skip root path
    if (path === "/" || path === "") {
      checks.push({
        name: "trailing-slash",
        status: "info",
        message: "Root URL (trailing slash check not applicable)",
      });
      return { checks };
    }

    // Check if path looks like a file (has extension)
    const hasExtension = /\.[a-z0-9]{2,4}$/i.test(path);
    const hasTrailingSlash = path.endsWith("/");

    if (hasExtension && hasTrailingSlash) {
      checks.push({
        name: "trailing-slash",
        status: "warn",
        message: "File URL has trailing slash",
        value: path,
      });
    } else if (hasExtension) {
      checks.push({
        name: "trailing-slash",
        status: "pass",
        message: "File URL correctly has no trailing slash",
      });
    } else {
      // Directory-like URL - just report the current state
      checks.push({
        name: "trailing-slash",
        status: "info",
        message: hasTrailingSlash
          ? "URL has trailing slash"
          : "URL has no trailing slash",
        value: "Ensure consistency across site",
      });
    }

    return { checks };
  },
};
