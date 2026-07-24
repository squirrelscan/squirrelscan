// gaps/keywords - keyword gap analysis (cloud-backed, site-scope)

import type { KeywordGapsResponse } from "@squirrelscan/core-contracts";

import { z } from "zod";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

/** Gaps at or above this monthly volume count as "high-volume". */
const HIGH_VOLUME_THRESHOLD = 500;
/** Warn when more than this many high-volume gaps exist. */
const HIGH_VOLUME_WARN_COUNT = 20;
/** Top gap keywords listed as check items. */
const MAX_ITEMS = 25;

export const optionsSchema = z.object({
  country: z.string().optional().describe("ISO country for search data (default US)"),
  language: z.string().optional().describe("Language code for search data (default en)"),
  competitors: z
    .array(z.string())
    .optional()
    .describe("Competitor domains to compare against (max 5)"),
});

export const keywordGapsRule: Rule = {
  meta: {
    id: "gaps/keywords",
    name: "Keyword Gaps",
    description:
      "Finds keywords competitors rank for (or seed-keyword opportunities) that this site doesn't rank for",
    solution:
      "Review the listed gap keywords and prioritize the high-volume ones that match your site's intent. " +
      "Create or expand pages targeting them — a dedicated page per keyword cluster generally outranks a " +
      "page that mentions the topic in passing. Configure competitor domains via the rule's `competitors` " +
      "option to sharpen the analysis.",
    category: "gaps",
    scope: "site",
    severity: "info",
    weight: 1,
    optionsSchema,
    // Opt-in only: keyword_gaps costs 25 credits/audit, so this stays disabled
    // (like ai/ai-content) and is excluded from selectCloudRules until the user
    // explicitly enables it (enable: ["gaps/keywords"]). Prevents surprise spend
    // on a default cloud-enabled audit, especially in non-TTY/agent mode where no
    // spend confirmation prompt is shown.
    disabled: true,
    cloud: { service: "keyword-gaps", unit: "site", creditFeature: "keyword_gaps" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<KeywordGapsResponse>(ctx.cloudResults, "keyword-gaps");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "keyword-gaps",
        status: "skipped",
        message: "Keyword gap analysis skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const { gaps, summary } = envelope.data;

    if (gaps.length === 0) {
      checks.push({
        name: "keyword-gaps",
        status: "pass",
        message: "No keyword gaps found",
        details: { summary },
      });
      return { checks };
    }

    checks.push({
      name: "keyword-gaps",
      status: "info",
      message: `${gaps.length} keyword gap${gaps.length === 1 ? "" : "s"} found`,
      value: gaps.length,
      items: gaps.slice(0, MAX_ITEMS).map((g) => ({
        id: g.keyword,
        label: g.volume != null ? `${g.keyword} — vol ${g.volume}` : g.keyword,
      })),
      details: { summary },
    });

    const highVolume = gaps.filter((g) => (g.volume ?? 0) >= HIGH_VOLUME_THRESHOLD);
    if (highVolume.length > HIGH_VOLUME_WARN_COUNT) {
      checks.push({
        name: "keyword-gaps-high-volume",
        status: "warn",
        message: `${highVolume.length} high-volume keyword gaps (≥${HIGH_VOLUME_THRESHOLD} searches/mo) — significant untapped search demand`,
        value: highVolume.length,
        expected: `<= ${HIGH_VOLUME_WARN_COUNT}`,
      });
    }

    return { checks };
  },
};
