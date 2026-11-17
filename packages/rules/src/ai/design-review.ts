// ai/design-review - LLM vision review of sampled page screenshots (cloud-backed, site-scope, opt-in)
//
// A vision model reviews screenshots of a bounded page sample, grounded in the
// site's own fonts, colors and spacing. This rule never calls a model: it reads
// the prefetched result and keeps only findings that are concrete (a sampled
// page, a named element, a measured deviation, and the site's own norm shown on
// another sampled page). Generic design advice is dropped, not reported.

import {
  DESIGN_REVIEW_MAX_FINDINGS,
  DESIGN_REVIEW_MAX_PAGES,
  type DesignReviewFinding,
  type DesignReviewResult,
} from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

/** A finding is concrete when it names a sampled page, an element, a measured deviation and the site's own norm. */
export function isConcreteFinding(f: DesignReviewFinding, sampled: ReadonlySet<string>): boolean {
  const refs = (f.referencePages ?? []).filter((u) => sampled.has(u) && u !== f.page);
  return (
    sampled.has(f.page) &&
    f.element?.trim().length > 0 &&
    // A measured deviation carries a number ("8px", "2 columns", "#1a73e8"), not an adjective.
    /\d|#[0-9a-f]{3,8}\b/i.test(f.deviation ?? "") &&
    f.siteNorm?.trim().length > 0 &&
    refs.length > 0
  );
}

export const designReviewRule: Rule = {
  meta: {
    id: "ai/design-review",
    name: "Design Review",
    description:
      "A vision model reviews screenshots of a bounded page sample for cross-page design inconsistencies measured against the site's own system",
    solution:
      "Each finding names a page, an element and the measured deviation from what the rest of the site does. Fix the element so it matches the pages cited as the norm, ideally by moving it into a shared component or design token so it cannot drift again. This is an opt-in cloud review: it runs only when LLM rules are enabled for the website.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 0,
    cloud: { service: "design-review", unit: "site", creditFeature: "llm_rules_page" },
    checks: [
      { name: "design-review", outcome: "skipped" },
      { name: "design-review", outcome: "clean", clears: ["design-review-deviation"] },
      { name: "design-review-deviation", outcome: "problem" },
    ],
  },

  run(ctx: RuleContext): RuleResult {
    const envelope = readCloudResult<DesignReviewResult>(ctx.cloudResults, "design-review");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped"
          ? (envelope.skipReason ?? "not-prefetched")
          : "not-prefetched";
      return {
        checks: [
          {
            name: "design-review",
            status: "skipped",
            message: "Design review skipped",
            skipReason: humanizeCloudSkip(reason),
          },
        ],
      };
    }

    const sampledPages = (envelope.data.sampledPages ?? []).slice(0, DESIGN_REVIEW_MAX_PAGES);
    const sampled = new Set(sampledPages);
    const findings = (envelope.data.findings ?? [])
      .filter((f) => isConcreteFinding(f, sampled))
      .slice(0, DESIGN_REVIEW_MAX_FINDINGS);

    if (findings.length === 0) {
      return {
        checks: [
          {
            name: "design-review",
            status: "pass",
            message: `No cross-page design inconsistencies in ${sampledPages.length} sampled pages`,
            value: String(sampledPages.length),
          },
        ],
      };
    }

    return {
      checks: findings.map(
        (f): CheckResult => ({
          name: "design-review-deviation",
          status: "warn",
          message: `${f.element} on ${f.page}: ${f.deviation} (site norm: ${f.siteNorm})`,
          details: { page: f.page, element: f.element, deviation: f.deviation, siteNorm: f.siteNorm, referencePages: f.referencePages },
        }),
      ),
    };
  },
};
