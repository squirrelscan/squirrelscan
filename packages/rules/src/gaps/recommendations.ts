// gaps/recommendations - generative content recommendations (cloud-backed, site-scope)

import type {
  ContentRecommendationCategory,
  ContentRecommendationItem,
  ContentRecommendationsResponse,
} from "@squirrelscan/core-contracts";

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

/** Suggestions listed per category check. */
const MAX_ITEMS = 15;

const CATEGORIES: { category: ContentRecommendationCategory; check: string; label: string }[] = [
  { category: "net-new-topic", check: "recommendations-net-new-topics", label: "net-new topic" },
  {
    category: "content-refresh",
    check: "recommendations-content-refresh",
    label: "content refresh",
  },
  {
    category: "cluster-completion",
    check: "recommendations-cluster-completion",
    label: "cluster completion",
  },
  { category: "format", check: "recommendations-formats", label: "format" },
  {
    category: "funnel-coverage",
    check: "recommendations-funnel-coverage",
    label: "funnel coverage",
  },
];

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export const optionsSchema = z.object({
  country: z.string().optional().describe("ISO country for search data (default US)"),
  language: z.string().optional().describe("Language code for search data (default en)"),
});

function describe(item: ContentRecommendationItem): string {
  const parts = [`[${item.priority}] ${item.rationale}`];
  if (item.signal)
    parts.push(`Signal: ${item.signal === "thin" ? "thin word count" : "stale content"}`);
  if (item.funnelStage) parts.push(`Funnel: ${item.funnelStage.toUpperCase()}`);
  if (item.pages?.length) parts.push(`Pages: ${item.pages.join(", ")}`);
  return parts.join(" ");
}

export const contentRecommendationsRule: Rule = {
  meta: {
    id: "gaps/recommendations",
    name: "Content Recommendations",
    description:
      "Suggests content to create or improve from the site's niche and its existing content, without competitor data",
    solution:
      "Each suggestion is a net-new topic, a refresh of a thin or stale page, a cluster to complete, " +
      "a format worth adding (FAQ, comparison, how-to, glossary) or a funnel stage with no coverage. " +
      "Work through the high-priority items first. Refresh suggestions name the exact pages and the " +
      "signal that triggered them.",
    category: "gaps",
    scope: "site",
    severity: "info",
    weight: 1,
    optionsSchema,
    // Opt-in only: content_recommendations is a paid, LLM-backed feature. A concrete
    // rule/category enable pattern can select it, while the default enable: ["*"] cannot.
    optIn: true,
    cloud: {
      service: "content-recommendations",
      unit: "site",
      creditFeature: "content_recommendations",
    },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<ContentRecommendationsResponse>(
      ctx.cloudResults,
      "content-recommendations",
    );
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped"
          ? (envelope.skipReason ?? "not-prefetched")
          : "not-prefetched";
      checks.push({
        name: "content-recommendations",
        status: "skipped",
        message: "Content recommendations skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { recommendations, summary } = envelope.data;

    if (recommendations.length === 0) {
      checks.push({
        name: "content-recommendations",
        status: "pass",
        message: "No content recommendations",
        details: { summary },
      });
      return { checks };
    }

    for (const { category, check, label } of CATEGORIES) {
      const inCategory = recommendations
        .filter((r) => r.category === category)
        .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      if (inCategory.length === 0) continue;
      checks.push({
        name: check,
        status: "info",
        message: `${inCategory.length} ${label} recommendation${inCategory.length === 1 ? "" : "s"}`,
        value: inCategory.length,
        items: inCategory.slice(0, MAX_ITEMS).map((r) => ({
          id: r.pages?.[0] ?? r.title,
          label: r.title,
          snippet: describe(r),
        })),
        details: { summary },
      });
    }

    return { checks };
  },
};
