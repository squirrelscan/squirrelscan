// performance/browser-required - Log browser-only audits

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const browserRequiredRule: Rule = {
  meta: {
    id: "perf/browser-required",
    name: "Browser-Required Audits",
    description: "Lists performance audits that require browser execution",
    solution:
      "For complete performance analysis, run browser-based tools like Lighthouse, WebPageTest, or Chrome DevTools. These tools measure actual runtime metrics that cannot be determined through static HTML analysis alone.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 1,
  },

  run(_ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    // List audits that require a browser to run
    const browserOnlyAudits = [
      // Core Web Vitals (actual measurements)
      "First Contentful Paint (FCP)",
      "Largest Contentful Paint (LCP)",
      "Total Blocking Time (TBT)",
      "Cumulative Layout Shift (CLS)",
      "Speed Index (SI)",
      "Interaction to Next Paint (INP)",

      // JavaScript execution
      "JavaScript execution time",
      "Main-thread work breakdown",
      "Long tasks",
      "Time to Interactive (TTI)",

      // Runtime behavior
      "Console errors",
      "JavaScript deprecations",
      "Browser feature detection",

      // Network waterfall
      "Network request timing",
      "Resource loading waterfall",

      // API detection (runtime-only, intentionally deferred)
      "Geolocation on load (navigator.geolocation at page load)",
      "Notification on load (Notification.requestPermission at page load)",
      "Permissions requests",
    ];

    checks.push({
      name: "browser-required-audits",
      status: "info",
      message: `${browserOnlyAudits.length} audits require browser execution`,
      items: browserOnlyAudits.slice(0, 10).map((id) => ({ id })),
      details: {
        note: "Run Lighthouse for complete metrics",
        totalAudits: browserOnlyAudits.length,
      },
    });

    return { checks };
  },
};
