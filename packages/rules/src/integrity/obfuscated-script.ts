// integrity/obfuscated-script — large inline script combining high entropy with
// packer/eval/anti-tamper markers (the ~152KB obfuscated payload from the real
// kit). Correlation-gated: lone signal → `info`; escalates with >=2 signals.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  detectObfuscatedScript,
  detectPageSignals,
  integrityScanNotes,
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
    verdictScope: "page",
    severity: "warning",
    weight: 8,
    // Check names by outcome class (#1741).
    checks: [
      { name: "obfuscated-script", outcome: "problem" },
      { name: "obfuscated-script", outcome: "clean", clears: ["obfuscated-script"] },
      { name: "obfuscated-script", outcome: "skipped" },
    ],
    // Compromise detection: an ignore could hide a compromised site (#1262).
    ignorable: false,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) {
      checks.push({
        name: "obfuscated-script",
        status: "skipped",
        message: "No document available",
        pageUrl: ctx.page.url,
        skipReason: "unread-page",
      });
      return { checks };
    }

    const hit = detectObfuscatedScript(ctx);
    if (!hit) {
      checks.push({
        name: "obfuscated-script",
        status: "pass",
        message: "No obfuscated inline script found on this page",
        pageUrl: ctx.page.url,
      });
      return { checks };
    }

    const signals = detectPageSignals(ctx);
    const escalate = shouldEscalate(signals, "obfuscated-script");
    const corroborating = [...signals].filter(
      (s) => s !== "obfuscated-script"
    );
    const kb = (hit.sizeBytes / 1024).toFixed(1);
    // A scan cut by its work bounds may have missed a corroborating signal: say so, as brand-impersonation does (#784).
    const notes = escalate ? {} : integrityScanNotes(ctx);
    const cutParts: string[] = [];
    if (notes.controlsUnread) cutParts.push(`${notes.controlsUnread} sign-in control${notes.controlsUnread === 1 ? "" : "s"} could not be read in full`);
    if (notes.templatesUnread) cutParts.push(`${notes.templatesUnread} <template> element${notes.templatesUnread === 1 ? " was" : "s were"} past the template limit and not read`);
    if (notes.hiddenCssTruncated) cutParts.push("a CSS rule too large to read may hide text in a sign-in label");
    const truncated = cutParts.length > 0;

    checks.push({
      name: "obfuscated-script",
      status: escalate ? "fail" : "info",
      message: escalate
        ? `Likely injected payload: ${kb}KB obfuscated inline script (${signals.size} corroborating integrity signals)`
        : `Suspicious ${kb}KB obfuscated inline script (single signal — review${truncated ? `; ${cutParts.join("; ")} (scan work limit), so a corroborating signal may be unread` : ""})`,
      pageUrl: ctx.page.url,
      value: `${kb}KB, entropy ${hit.entropy}, markers: ${hit.markers.join(", ")}`,
      details: {
        sizeBytes: hit.sizeBytes,
        entropy: hit.entropy,
        markers: hit.markers,
        signals: [...signals],
        corroborating,
        escalated: escalate,
        ...(truncated ? { scanTruncated: true, ...notes } : {}),
      },
    });

    return { checks };
  },
};
