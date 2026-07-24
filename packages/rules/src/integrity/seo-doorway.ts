// integrity/seo-doorway — injected off-topic, keyword-stuffed affiliate doorway
// post ("Calendly ClickFunnels 2.0 (5 HELPFUL TIPS)"). Correlation-gated: a lone
// doorway signal → `info` (could be legit affiliate content); escalates when it
// corroborates with template-discontinuity / orphan / brand signals.

import type { Rule, RuleContext, RuleResult, CheckResult } from "../types";

import {
  detectPageSignals,
  detectSeoDoorway,
  shouldEscalate,
} from "./signals";

export const seoDoorwayRule: Rule = {
  meta: {
    id: "integrity/seo-doorway",
    name: "SEO Doorway Page",
    description:
      "Detects injected off-topic, keyword-stuffed affiliate doorway posts that diverge from the rest of the site's content",
    solution:
      "Off-topic, thin, keyword-stuffed affiliate posts injected into a site are a parasite-SEO compromise: they hijack the domain's authority to rank spam. If you did not publish this content, treat the site as compromised: remove the injected posts, audit your CMS for unauthorized authors/plugins, and check server logs. Google penalizes doorway pages, so leaving them up risks ranking damage.",
    category: "integrity",
    scope: "page",
    severity: "warning",
    weight: 6,
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];
    if (!ctx.parsed.document) return { checks };

    const hit = detectSeoDoorway(ctx);
    if (!hit) {
      return { checks };
    }

    const signals = detectPageSignals(ctx);
    const escalate = shouldEscalate(signals, "seo-doorway");
    const corroborating = [...signals].filter((s) => s !== "seo-doorway");

    checks.push({
      name: "seo-doorway",
      status: escalate ? "fail" : "info",
      message: escalate
        ? `Likely injected SEO doorway page (${signals.size} corroborating integrity signals)`
        : `Possible SEO doorway / affiliate spam page (single signal — review)`,
      pageUrl: ctx.page.url,
      value: hit.reason,
      details: {
        matchedTerms: hit.matchedTerms,
        signals: [...signals],
        corroborating,
        escalated: escalate,
      },
    });

    return { checks };
  },
};
