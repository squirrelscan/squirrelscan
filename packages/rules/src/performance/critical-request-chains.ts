// perf/critical-request-chains - Identifies chains of dependent resources delaying render

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

export const criticalRequestChainsRule: Rule = {
  meta: {
    id: "perf/critical-request-chains",
    name: "Critical Request Chains",
    description:
      "Identifies chains of dependent resources that delay rendering",
    solution:
      "Critical request chains are sequences of dependent network requests that must complete before the page can render. Reduce chain depth by: 1) Inlining critical CSS instead of linking external files. 2) Adding async or defer to non-critical scripts. 3) Avoiding CSS @import — use <link> tags instead. 4) Using <link rel='preload'> for critical resources. 5) Reducing the number of render-blocking resources in <head>.",
    category: "perf",
    scope: "page",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    const head = doc.querySelector("head");
    if (!head) {
      checks.push({
        name: "critical-request-chains",
        status: "info",
        message: "No <head> element found",
      });
      return { checks };
    }

    // Find render-blocking CSS (link[rel=stylesheet] without media=print/disabled)
    const blockingCss = head.querySelectorAll(
      'link[rel="stylesheet"]:not([media="print"]):not([disabled])'
    );

    // Find render-blocking JS (script without async/defer/type=module in head)
    const blockingJs = head.querySelectorAll(
      "script[src]:not([async]):not([defer]):not([type='module'])"
    );

    // Count CSS @import statements from inline styles
    let importCount = 0;
    const styleElements = doc.querySelectorAll("style");
    for (const style of styleElements) {
      const content = style.textContent || "";
      const imports = content.match(/@import\b/g);
      if (imports) {
        importCount += imports.length;
      }
    }

    // Check for preload hints
    const preloads = head.querySelectorAll('link[rel="preload"]');

    const chainMembers: string[] = [];

    for (const css of blockingCss) {
      const href = css.getAttribute("href") || "unknown";
      chainMembers.push(`CSS: ${href}`);
    }

    for (const js of blockingJs) {
      const src = js.getAttribute("src") || "unknown";
      chainMembers.push(`JS: ${src}`);
    }

    if (importCount > 0) {
      chainMembers.push(
        `${importCount} CSS @import(s) found (each adds a network round-trip)`
      );
    }

    if (chainMembers.length > 0) {
      checks.push({
        name: "critical-request-chains",
        status: "warn",
        message: `${chainMembers.length} critical request chain(s) found`,
        items: chainMembers.slice(0, 10).map((id) => ({ id })),
        details: {
          blockingCss: blockingCss.length,
          blockingJs: blockingJs.length,
          importCount,
          preloads: preloads.length,
          ...(chainMembers.length > 10
            ? { additional: chainMembers.length - 10 }
            : {}),
        },
      });
    } else {
      checks.push({
        name: "critical-request-chains",
        status: "pass",
        message: "No critical request chains detected",
        details: { preloads: preloads.length },
      });
    }

    return { checks };
  },
};
