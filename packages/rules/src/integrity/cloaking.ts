// integrity/cloaking — flag pages that serve materially different content to a
// Googlebot UA than to a normal visitor (UA cloaking), or whose content changes
// when a query token is appended (token-gating). Both are classic ways an
// injected SEO-spam / phishing kit hides from the site owner while still ranking:
// the crawler/owner sees a clean page, the search engine (or a tokened link) sees
// the payload.
//
// Reads `ctx.site.cloakingProbes` — the opt-in differential probe results
// assembled by audit-engine BEFORE rules run (re-fetches suspicious paths with a
// googlebot UA + a query variation and compares responses). When the probe is off
// (`cloakingProbes` undefined) this rule is a no-op; it never reports "clean" for
// paths it never probed.

import type { CloakingProbeData } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import { getPathname } from "@squirrelscan/utils";

/** One-line human summary of why a probe diverged on UA. */
function describeUaDivergence(p: CloakingProbeData): string {
  const path = getPathname(p.url) || p.url;
  const defOk = p.defaultStatus >= 200 && p.defaultStatus < 300;
  const gbOk = p.googlebotStatus >= 200 && p.googlebotStatus < 300;
  if (defOk !== gbOk) {
    return `${path}: googlebot got ${p.googlebotStatus}, normal visitor got ${p.defaultStatus} (UA-gated response)`;
  }
  return `${path}: googlebot content only ${Math.round(p.uaSimilarity * 100)}% similar to the normal-visitor page`;
}

/** One-line human summary of why a probe looks token-gated. */
function describeTokenGating(p: CloakingProbeData): string {
  const path = getPathname(p.url) || p.url;
  const defOk = p.defaultStatus >= 200 && p.defaultStatus < 300;
  const qOk = p.queryStatus != null && p.queryStatus >= 200 && p.queryStatus < 300;
  if (defOk !== qOk) {
    return `${path}: response flips to ${p.queryStatus} when a query token is appended (token-gated)`;
  }
  const sim = p.querySimilarity == null ? 0 : Math.round(p.querySimilarity * 100);
  return `${path}: content changes (${sim}% similar) when a query token is appended`;
}

export const cloakingRule: Rule = {
  meta: {
    id: "integrity/cloaking",
    name: "Cloaking / UA-Gated Content",
    description:
      "Detects pages that serve materially different content to a Googlebot user-agent than to a normal visitor (UA cloaking), or that change their response when a URL query token is added (token-gating) — both are ways an injected SEO-spam or phishing payload hides from the site owner. Requires the opt-in integrity cloaking probe.",
    solution:
      "A page that shows search engines (or tokened links) different content than it shows you is cloaking — almost always an injected payload or a deceptive doorway, and a likely compromise. Fetch the URL yourself with a Googlebot user-agent (e.g. `curl -A 'Googlebot' <url>`) to see the hidden content, then audit recently modified files/plugins and server-side rules that branch on user-agent or query string. Legitimate UA/geo personalization should never change the core indexable content.",
    category: "integrity",
    scope: "site",
    severity: "error",
    weight: 7,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const probes = ctx.site?.cloakingProbes;

    // Opt-in: undefined means the probe never ran — contribute nothing rather
    // than imply a clean bill of health.
    if (!probes) return { checks };

    if (probes.length === 0) {
      checks.push({
        name: "cloaking",
        status: "pass",
        message: "No suspicious paths to probe for cloaking",
      });
      return { checks };
    }

    const cloaked = probes.filter((p) => p.uaCloaking);
    // Token-gating is a softer signal; don't double-report a page already failed
    // for UA cloaking.
    const tokenGated = probes.filter((p) => p.tokenGated && !p.uaCloaking);

    if (cloaked.length > 0) {
      checks.push({
        name: "cloaking",
        status: "fail",
        message: `${cloaked.length} page(s) serve different content to googlebot than to a normal visitor — likely cloaking`,
        value: cloaked.slice(0, 5).map(describeUaDivergence).join("\n"),
        items: cloaked.map((p) => ({ id: p.url })),
        details: { total: cloaked.length, kind: "ua-cloaking" },
      });
    }

    if (tokenGated.length > 0) {
      checks.push({
        name: "cloaking-token-gated",
        status: "warn",
        message: `${tokenGated.length} page(s) change their response when a query token is appended — possible token-gated content`,
        value: tokenGated.slice(0, 5).map(describeTokenGating).join("\n"),
        items: tokenGated.map((p) => ({ id: p.url })),
        details: { total: tokenGated.length, kind: "token-gating" },
      });
    }

    if (checks.length === 0) {
      checks.push({
        name: "cloaking",
        status: "pass",
        message: `Probed ${probes.length} suspicious path(s) — no UA cloaking or token-gating detected`,
        details: { probed: probes.length },
      });
    }

    return { checks };
  },
};
