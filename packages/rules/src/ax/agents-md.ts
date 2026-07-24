// ax/agents-md - detect /AGENTS.md and its conventional variants

import type { WellKnownProbe } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

// Probed in this order (mirrors packages/crawler/src/well-known.ts WELL_KNOWN_PATHS).
const AGENTS_MD_PATHS: readonly string[] = [
  "/AGENTS.md",
  "/agents.md",
  "/.well-known/agents.md",
  "/docs/AGENTS.md",
];

// A real hit: 200, not an HTML/SPA-fallback body, and content that reads as
// plain text/Markdown rather than something the crawler happened to 200 on.
function isRealHit(p: WellKnownProbe): boolean {
  return p.status === 200 && !p.looksHtml && p.markdownLike;
}

export const agentsMdRule: Rule = {
  meta: {
    id: "ax/agents-md",
    name: "AGENTS.md",
    description:
      "Detects /AGENTS.md (and variants) — plain-Markdown instructions for coding agents working against the site's repository",
    solution:
      "If the site has an associated codebase, publish an AGENTS.md at the repository root covering setup, testing, and conventions a coding agent needs to be productive. This is a recommendation only — it never affects your score.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    const wk = ctx.site?.wellKnown;

    if (!wk) {
      checks.push({ name: "agents-md", status: "info", message: "well-known probe data not available" });
      return { checks };
    }

    const probes = wk.probes.filter((p) => AGENTS_MD_PATHS.includes(p.path));
    const hit = probes.find(isRealHit);

    if (hit) {
      checks.push({
        name: "agents-md-present",
        status: "info",
        message: `AGENTS.md found at ${hit.path} (${hit.bodySize} bytes)`,
        value: "present",
        details: { path: hit.path, bodySize: hit.bodySize, excerpt: hit.excerpt.slice(0, 200) },
      });
      return { checks };
    }

    // A 200 that sniffed as HTML is the classic SPA-fallback trap — every
    // path returns the same index.html, so it must never read as "present".
    const spaFallback = probes.find((p) => p.status === 200 && p.looksHtml);
    if (spaFallback) {
      checks.push({
        name: "agents-md-present",
        status: "info",
        message: `${spaFallback.path} responded 200 but returned an HTML page (SPA fallback) — not a real AGENTS.md`,
        value: "spa-fallback",
        details: { path: spaFallback.path },
      });
      return { checks };
    }

    // Only recommend AGENTS.md to sites that already publish llms.txt — the
    // strongest available signal of a developer-oriented site. For everyone
    // else (the local plumber), absence stays a quiet info note.
    const publishesLlmsTxt = ctx.site?.llmsTxt?.llmsTxt.exists === true;
    checks.push({
      name: "agents-md-present",
      status: publishesLlmsTxt ? "warn" : "info",
      message: publishesLlmsTxt
        ? "No AGENTS.md found — this site publishes llms.txt, so consider an AGENTS.md for coding agents too"
        : "No AGENTS.md found — consider adding one if this site has an associated codebase",
      value: "absent",
    });
    return { checks };
  },
};
