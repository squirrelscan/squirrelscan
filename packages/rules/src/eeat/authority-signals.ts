// eeat/authority-signals - AI-assessed authority signals per page (cloud-backed)

import type { AuthorityResult } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

export const authoritySignalsRule: Rule = {
  meta: {
    id: "eeat/authority-signals",
    name: "Authority Signals",
    description:
      "AI assessment of per-page authority signals: authorship, citations, and outbound references",
    solution:
      "Pages that demonstrate who wrote them and what their claims rest on earn more trust from readers, search engines, and AI assistants. Add a visible author byline (with credentials where relevant), cite sources for factual claims, and link out to authoritative references.",
    category: "eeat",
    scope: "page",
    severity: "warning",
    weight: 3,
    // Assessing authorship/citations on a soft-404 error page is meaningless —
    // skip so a broken template can't warn "no author" per page (#1174).
    skipOnSoft404: true,
    cloud: { service: "authority-signals", unit: "page", creditFeature: "authority_signals" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<AuthorityResult>(ctx.cloudResults, "authority-signals", ctx.page.url);
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason = envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "authority-signals",
        status: "skipped",
        message: "Authority signal analysis skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { authorPresent, citationCount, outboundLinkCount, signals } = envelope.data;

    if (!authorPresent && citationCount === 0) {
      checks.push({
        name: "authority-signals",
        status: "warn",
        message: "No author attribution or citations detected on this page",
        details:
          outboundLinkCount > 0
            ? { note: `${outboundLinkCount} outbound link(s) present but none read as citations.` }
            : undefined,
      });
    } else {
      const parts = [
        authorPresent ? "author attributed" : "no author",
        `${citationCount} citation(s)`,
        `${outboundLinkCount} outbound reference(s)`,
      ];
      checks.push({
        name: "authority-signals",
        status: "pass",
        message: `Authority signals: ${parts.join(", ")}`,
        items:
          signals.length > 0 ? signals.map((s, i) => ({ id: `signal-${i}`, label: s })) : undefined,
      });
    }

    return { checks };
  },
};
