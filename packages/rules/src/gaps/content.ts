// gaps/content - content gap topic analysis (cloud-backed, site-scope)

import {
  rankContentGaps,
  type ContentGapsResponse,
  type RankedContentGap,
} from "@squirrelscan/core-contracts";

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

/** Topic gaps at or above this combined monthly volume count as "high-volume". */
const HIGH_VOLUME_THRESHOLD = 500;
/** Warn when more than this many high-volume topic gaps exist. */
const HIGH_VOLUME_WARN_COUNT = 20;
/** Top gap topics listed as check items. */
const MAX_ITEMS = 25;
/** Member keywords shown per topic in an item snippet. */
const MAX_KEYWORDS = 5;

/** `topic (score S, vol V, difficulty D)`, naming only the values that are known. */
function opportunityLabel(g: RankedContentGap): string {
  const parts = [`score ${g.score}`];
  if (g.volume != null) parts.push(`vol ${g.volume}`);
  if (g.difficulty != null) parts.push(`difficulty ${g.difficulty}`);
  return `${g.topic} (${parts.join(", ")})`;
}

export const optionsSchema = z.object({
  country: z.string().optional().describe("ISO country for search data (default US)"),
  language: z.string().optional().describe("Language code for search data (default en)"),
  competitors: z
    .array(z.string())
    .optional()
    .describe("Competitor domains to compare against (max 5)"),
});

export const contentGapsRule: Rule = {
  meta: {
    id: "gaps/content",
    name: "Content Gaps",
    description:
      "Finds topic clusters with search demand around the site's existing content that lack dedicated coverage",
    solution:
      "Each gap is a topic cluster with combined search volume the site doesn't cover directly. " +
      "Plan content (guides, comparisons, FAQs) around the highest-volume clusters first, since they're " +
      "adjacent to what you already rank for, so new pages benefit from existing topical authority.",
    category: "gaps",
    scope: "site",
    severity: "recommendation",
    weight: 1,
    optionsSchema,
    // Opt-in only: content_gaps costs 25 credits/audit. A concrete rule/category
    // enable pattern can select it, while the default enable: ["*"] cannot.
    optIn: true,
    cloud: { service: "content-gaps", unit: "site", creditFeature: "content_gaps" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<ContentGapsResponse>(ctx.cloudResults, "content-gaps");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "content-gaps",
        status: "skipped",
        message: "Content gap analysis skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { gaps, summary } = envelope.data;

    if (gaps.length === 0) {
      checks.push({
        name: "content-gaps",
        status: "pass",
        message: "No content gaps found",
        details: { summary },
      });
      return { checks };
    }

    const ranked = rankContentGaps(gaps).slice(0, MAX_ITEMS);
    checks.push({
      name: "content-gaps",
      status: "warn",
      message: `${gaps.length} content gap topic${gaps.length === 1 ? "" : "s"} found`,
      value: gaps.length,
      items: ranked.map((g) => ({
        id: g.topic,
        label: opportunityLabel(g),
        snippet: g.keywords?.length
          ? `${g.reason} (keywords: ${g.keywords.slice(0, MAX_KEYWORDS).join(", ")})`
          : g.reason,
      })),
      details: {
        summary,
        opportunities: ranked.map((g) => ({
          topic: g.topic,
          score: g.score,
          volume: g.volume ?? null,
          difficulty: g.difficulty ?? null,
          relevance: g.relevance ?? null,
          keywords: g.keywords ?? [],
        })),
      },
    });

    const highVolume = gaps.filter((g) => (g.volume ?? 0) >= HIGH_VOLUME_THRESHOLD);
    if (highVolume.length > HIGH_VOLUME_WARN_COUNT) {
      checks.push({
        name: "content-gaps-high-volume",
        status: "warn",
        message: `${highVolume.length} high-volume content gap topics (≥${HIGH_VOLUME_THRESHOLD} combined searches/mo): significant uncovered demand`,
        value: highVolume.length,
        expected: `<= ${HIGH_VOLUME_WARN_COUNT}`,
      });
    }

    return { checks };
  },
};
