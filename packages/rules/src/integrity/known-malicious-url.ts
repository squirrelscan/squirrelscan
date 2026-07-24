// integrity/known-malicious-url — cross-reference this site's own URLs (domain,
// page final URLs) and its outbound external links against threat-intel feeds +
// on-demand lookups (#117). Catches token-gated / cloaked kits that never render
// for our crawler but are already listed by Safe Browsing / URLhaus / urlscan /
// VirusTotal / OpenPhish, and flags outbound links to known-malicious hosts.
//
// Pure: all feed pulls + lookups happen in audit-engine's intel prefetch before
// rules run; this rule reads synchronous, memoized verdicts off `ctx.intel`.
// When intel is off (opt-in not enabled) `ctx.intel` is undefined → no-op. When
// intel is on but no provider was consulted for a URL (`checked: false`) the rule
// stays silent for it — absence of data is never reported as "clean".

import type { IntelUrlVerdict } from "@squirrelscan/core-contracts";

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

interface Candidate {
  url: string;
  origin: "site" | "external-link";
}

/** Site's own URLs + outbound external links, de-duplicated, tagged by origin. */
function collectCandidates(ctx: RuleContext): Candidate[] {
  const site = ctx.site;
  if (!site) return [];
  const seen = new Map<string, Candidate>();
  const add = (url: string | undefined, origin: Candidate["origin"]) => {
    if (!url) return;
    if (!seen.has(url)) seen.set(url, { url, origin });
  };

  add(site.baseUrl, "site");
  for (const page of site.pages) {
    add(page.url, "site");
    add(page.finalUrl, "site");
  }
  for (const link of site.externalLinks ?? []) {
    add(link.href, "external-link");
  }
  return [...seen.values()];
}

export const knownMaliciousUrlRule: Rule = {
  meta: {
    id: "integrity/known-malicious-url",
    name: "Known Malicious URL",
    description:
      "Cross-references the site's own URLs and outbound external links against threat-intel feeds (Safe Browsing, URLhaus, ThreatFox, urlscan, VirusTotal, OpenPhish, PhishTank). Opt-in; requires the [intel] feature.",
    solution:
      "A site URL flagged by a threat feed means the page is serving (or is hosting an injected) phishing/malware payload — likely a compromise. Remove the offending content, rotate credentials, and request a review from the listing provider once clean. A flagged OUTBOUND link points your visitors at a malicious host: remove or replace the link, and check whether it was injected (a compromise signal in its own right).",
    category: "integrity",
    scope: "site",
    severity: "error",
    weight: 9,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    // Opt-in: no intel handle means the feature is off — contribute nothing.
    if (!ctx.intel) return { checks };

    const candidates = collectCandidates(ctx);
    let anyChecked = false;

    for (const candidate of candidates) {
      const verdict: IntelUrlVerdict = ctx.intel.lookupUrl(candidate.url);
      if (verdict.checked) anyChecked = true;
      if (!verdict.listed) continue;

      const providers = verdict.sources.map((s) => s.provider);
      const threats = [...new Set(verdict.sources.map((s) => s.threat).filter(Boolean))];
      const isOwnSite = candidate.origin === "site";
      checks.push({
        name: "known-malicious-url",
        status: "fail",
        message: isOwnSite
          ? `Site URL flagged as malicious by ${providers.join(", ")}${threats.length ? ` (${threats.join(", ")})` : ""}`
          : `Outbound link to a known-malicious URL flagged by ${providers.join(", ")}${threats.length ? ` (${threats.join(", ")})` : ""}`,
        pageUrl: candidate.url,
        value: candidate.url,
        details: {
          origin: candidate.origin,
          providers,
          threats,
          sources: verdict.sources,
        },
      });
    }

    // Nothing was actually consulted (no provider configured/reachable for any
    // candidate) — stay silent rather than imply a clean bill of health.
    if (!anyChecked) return { checks };

    // Consulted and clean → one reassuring pass for the report.
    if (checks.length === 0) {
      checks.push({
        name: "known-malicious-url",
        status: "pass",
        message: "No site URLs or outbound links matched any threat-intel feed",
        pageUrl: ctx.site?.baseUrl,
        details: { providers: ctx.intel.providers, checked: candidates.length },
      });
    }

    return { checks };
  },
};
