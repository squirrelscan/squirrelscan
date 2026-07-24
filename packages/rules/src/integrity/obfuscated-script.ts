// integrity/obfuscated-script — large inline script combining high entropy with
// packer/eval/anti-tamper markers (the ~152KB obfuscated payload from the real
// kit). Correlation-gated: lone signal → `info`; escalates with >=2 signals.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  detectObfuscatedScript,
  detectPageSignals,
  shouldEscalate,
} from "./signals";

export const obfuscatedScriptRule: Rule = {
  meta: {
    id: "integrity/obfuscated-script",
    name: "Obfuscated Inline Script",
    description:
      "Detects large inline scripts with high entropy and obfuscation markers (eval, char-code arithmetic, anti-tamper strings) typical of injected payloads",
    solution:
      "A large, high-entropy inline script using eval/packers or anti-tamper strings is rarely something a legitimate site ships inline. If you did not add it, treat the page as compromised: identify the file serving it, remove the injected script, scan for dropped PHP/JS, and rotate credentials. Legitimate heavy JS should be served as an external, source-mapped bundle, not an obfuscated inline blob.",
    category: "integrity",
    scope: "page",
    severity: "warning",
    weight: 8,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) return { checks };

    const hit = detectObfuscatedScript(ctx);
    if (!hit) {
      return { checks };
    }

    const signals = detectPageSignals(ctx);
    const escalate = shouldEscalate(signals, "obfuscated-script");
    const corroborating = [...signals].filter(
      (s) => s !== "obfuscated-script"
    );
    const kb = (hit.sizeBytes / 1024).toFixed(1);

    checks.push({
      name: "obfuscated-script",
      status: escalate ? "fail" : "info",
      message: escalate
        ? `Likely injected payload: ${kb}KB obfuscated inline script (${signals.size} corroborating integrity signals)`
        : `Suspicious ${kb}KB obfuscated inline script (single signal — review)`,
      pageUrl: ctx.page.url,
      value: `${kb}KB, entropy ${hit.entropy}, markers: ${hit.markers.join(", ")}`,
      details: {
        sizeBytes: hit.sizeBytes,
        entropy: hit.entropy,
        markers: hit.markers,
        signals: [...signals],
        corroborating,
        escalated: escalate,
      },
    });

    return { checks };
  },
};
