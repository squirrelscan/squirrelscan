// perf/lcp-fetchpriority - LCP candidate eagerly loaded without fetchpriority or preload

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import {
  collectImagePreloadKeys,
  findLcpCandidate,
  isImagePreloaded,
} from "../shared/lcp-candidate";

export const lcpFetchpriorityRule: Rule = {
  meta: {
    id: "perf/lcp-fetchpriority",
    name: "LCP Image Fetch Priority",
    description:
      "Flags the hero/LCP image when it is eagerly loaded but has neither fetchpriority='high' nor a preload",
    solution:
      "The Largest Contentful Paint image should be discovered and fetched as early as possible. When the hero image is loaded eagerly but left at default priority, the browser races it against other resources and LCP suffers. Add fetchpriority='high' to the LCP <img> so the browser prioritises it, or preload it with <link rel='preload' as='image' href='...' fetchpriority='high'>. Either signal is enough; you do not need both. Only apply this to the single above-fold LCP image, never to below-fold images.",
    category: "perf",
    scope: "page",
    verdictScope: "page",
    severity: "warning",
    // Low weight on purpose: lcp-hints (weight 7) already penalizes the
    // no-preload case, so this rule adds the fetchpriority nudge without
    // double-charging the same root cause (PR #710 review).
    weight: 2,
  },

  run(ctx: RuleContext): RuleResult {
    const doc = ctx.parsed.document;
    if (!doc) return { checks: [] };
    const checks: CheckResult[] = [];

    // The hero candidate comes from the shared finder, so perf/lcp-hints agrees.
    const candidate = findLcpCandidate(doc);

    if (!candidate) {
      checks.push({
        name: "lcp-fetchpriority",
        status: "info",
        message: "No eager hero image candidate found",
      });
      return { checks };
    }

    const src = candidate.getAttribute("src") ?? "";
    const fetchpriority = candidate.getAttribute("fetchpriority");
    const hasHighPriority = fetchpriority === "high";

    const isPreloaded = isImagePreloaded(
      candidate,
      collectImagePreloadKeys(doc, ctx.page.url),
      ctx.page.url,
    );

    if (hasHighPriority || isPreloaded) {
      checks.push({
        name: "lcp-fetchpriority",
        status: "pass",
        message: hasHighPriority
          ? "Hero image has fetchpriority='high'"
          : "Hero image is preloaded",
      });
      return { checks };
    }

    const filename = src.split("/").pop()?.split("?")[0] || src;
    checks.push({
      name: "lcp-fetchpriority",
      status: "warn",
      message: "Hero/LCP image loaded eagerly without fetchpriority='high' or preload",
      items: [
        {
          id: src,
          label: filename,
          snippet: `<img src="${src}"${fetchpriority ? ` fetchpriority="${fetchpriority}"` : ""}>`,
        },
      ],
    });
    return { checks };
  },
};
