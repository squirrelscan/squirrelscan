// integrity/kit-signature — match a page's HTML/JS against the threat-intel kit
// signature engine (#117). Catches known phishing/malware kits (e.g. the Calendly
// credential kit) by their structural fingerprint even when the page is an
// off-theme, token-gated standalone doc that the Phase-A heuristics might miss.
//
// Pure: the signatures are loaded by audit-engine into `ctx.intel` before rules
// run; this rule only runs the synchronous matcher over its own page. When intel
// is off (opt-in not enabled) `ctx.intel` is undefined and the rule is a no-op.
//
// Signatures are written to be high-precision (the condition requires multiple
// corroborating strings — brand + a kit tell), so a match emits `fail` directly
// rather than going through the Phase-A correlation gate.

import type { SignatureMatchInput } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

/** External script bodies fetched for this page (inline scripts live in html). */
function scriptsForPage(ctx: RuleContext): string[] {
  const scripts = ctx.site?.scripts;
  if (!scripts || scripts.length === 0) return [];
  const pageUrls = new Set([ctx.page.url, ctx.page.finalUrl].filter(Boolean) as string[]);
  const out: string[] = [];
  for (const s of scripts) {
    if (!s.content) continue;
    if (s.sourcePages.some((p) => pageUrls.has(p))) out.push(s.content);
  }
  return out;
}

export const kitSignatureRule: Rule = {
  meta: {
    id: "integrity/kit-signature",
    name: "Kit Signature",
    description:
      "Matches the page's HTML and JavaScript against threat-intel signatures of known phishing/malware kits (e.g. the Calendly credential kit). Opt-in; requires the [intel] feature.",
    solution:
      "A page matching a known kit signature is a strong indicator your site is compromised: an injected, often token-gated standalone page that impersonates a brand's login/booking surface to harvest credentials. Remove the page and any unexpected files, rotate credentials, audit server access logs, and review for a web-shell or injected loader. Signatures are high-precision (they require multiple corroborating strings), so a match is not a casual false positive.",
    category: "integrity",
    scope: "page",
    severity: "error",
    weight: 9,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    // Opt-in: no intel handle means the feature is off — contribute nothing.
    if (!ctx.intel) return { checks };

    const input: SignatureMatchInput = {
      url: ctx.page.url,
      title: ctx.parsed.meta.title ?? undefined,
      html: ctx.page.html,
      text: ctx.parsed.content.textContent ?? undefined,
      scripts: scriptsForPage(ctx),
    };

    const matches = ctx.intel.matchSignatures(input);
    for (const m of matches) {
      checks.push({
        name: "kit-signature",
        status: "fail",
        message: `Matched kit signature "${m.name}" (${m.matchedStrings.join(", ")})`,
        pageUrl: ctx.page.url,
        value: m.id,
        details: {
          signatureId: m.id,
          severity: m.severity,
          matchedStrings: m.matchedStrings,
          description: m.description,
        },
      });
    }

    return { checks };
  },
};
