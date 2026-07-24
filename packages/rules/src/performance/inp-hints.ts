// perf/inp-hints - INP optimization hints

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getCWVHints } from "./cwv";

export const inpHintsRule: Rule = {
  meta: {
    id: "perf/inp-hints",
    name: "INP Optimization Hints",
    description: "Checks for Interaction to Next Paint optimization",
    solution:
      "INP measures responsiveness to user interactions. Improve by: 1) Minimize third-party scripts that block the main thread. 2) Use async/defer for non-critical scripts. 3) Break up long JavaScript tasks into smaller chunks. 4) Use web workers for heavy computations. 5) Implement code splitting to reduce initial bundle size. Consider using requestIdleCallback for non-urgent work.",
    category: "perf",
    scope: "page",
    severity: "info",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult {
    const hints = getCWVHints(ctx.parsed.document, ctx.page.html, ctx.page.url);
    const checks: CheckResult[] = [];

    // Check third-party scripts
    if (hints.thirdPartyScripts.length > 5) {
      checks.push({
        name: "inp-third-party",
        status: "warn",
        message: `${hints.thirdPartyScripts.length} third-party scripts may impact INP`,
        items: hints.thirdPartyScripts.map((url) => ({ id: url })),
        details: { count: hints.thirdPartyScripts.length },
      });
    } else if (hints.thirdPartyScripts.length > 0) {
      checks.push({
        name: "inp-third-party",
        status: "info",
        message: `${hints.thirdPartyScripts.length} third-party script(s) detected`,
        items: hints.thirdPartyScripts.map((url) => ({ id: url })),
      });
    } else {
      checks.push({
        name: "inp-third-party",
        status: "pass",
        message: "No third-party scripts detected",
      });
    }

    // Check script loading patterns
    if (hints.blockingScripts > 3) {
      checks.push({
        name: "inp-blocking-scripts",
        status: "warn",
        message: `${hints.blockingScripts} blocking scripts (consider async/defer)`,
        details: {
          async: hints.asyncScripts,
          defer: hints.deferScripts,
          blocking: hints.blockingScripts,
        },
      });
    } else if (hints.totalScripts > 0) {
      checks.push({
        name: "inp-blocking-scripts",
        status: "pass",
        message: "Script loading patterns look good",
        details: {
          async: hints.asyncScripts,
          defer: hints.deferScripts,
          blocking: hints.blockingScripts,
        },
      });
    }

    return { checks };
  },
};
