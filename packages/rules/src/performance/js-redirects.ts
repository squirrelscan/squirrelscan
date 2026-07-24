// perf/js-redirects - JavaScript resources with redirects

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

export const jsRedirectsRule: Rule = {
  meta: {
    id: "perf/js-redirects",
    name: "JavaScript Redirects",
    description: "Detects JavaScript resources that return 3XX redirects",
    solution:
      "JavaScript files that redirect add unnecessary latency and increase page load time. Update script src attributes to point directly to the final URL. Common causes: CDN URL changes, versioned script paths, or domain migrations. Check if third-party scripts have updated their recommended URLs.",
    category: "perf",
    scope: "site",
    severity: "warning",
    weight: 4,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const scripts = ctx.site?.scripts;

    if (!scripts || scripts.length === 0) {
      checks.push({
        name: "js-redirects",
        status: "skipped",
        message: "No JavaScript resources available for analysis",
      });
      return { checks };
    }

    // Filter scripts with 3XX redirect status
    const redirectingScripts = scripts.filter(
      (script) =>
        script.status !== null && script.status >= 300 && script.status < 400
    );

    if (redirectingScripts.length > 0) {
      const pathList = redirectingScripts
        .slice(0, 5)
        .map((script) => `${getPathname(script.url)} (${script.status})`)
        .join("\n");

      const suffix =
        redirectingScripts.length > 5
          ? `\n+${redirectingScripts.length - 5} more`
          : "";

      checks.push({
        name: "js-redirects",
        status: "warn",
        message: `${redirectingScripts.length} JavaScript resource(s) redirect`,
        items: redirectingScripts.map((script) => ({
          id: script.url,
          label: `${script.status}`,
          sourcePages: script.sourcePages,
          meta: {
            status: script.status,
            contentType: script.contentType,
          },
        })),
        details: { total: redirectingScripts.length },
        value: pathList + suffix,
      });
    } else {
      checks.push({
        name: "js-redirects",
        status: "pass",
        message: "No JavaScript resources are redirecting",
      });
    }

    return { checks };
  },
};
