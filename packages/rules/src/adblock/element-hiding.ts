// adblock/element-hiding - selectors hidden by EasyList cosmetic rules
// (cloud-backed, site-scope — server matches against the full EasyList)

import { z } from "zod";

import type { BlocklistCheckResponse } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

export const optionsSchema = z.object({
  maxMatchesToReport: z
    .number()
    .default(10)
    .describe("Maximum matching selectors to report in detail"),
});

export const elementHidingRule: Rule = {
  meta: {
    id: "adblock/element-hiding",
    name: "Adblock Element Hiding",
    description:
      "Checks for elements that would be hidden by common adblockers (EasyList cosmetic rules)",
    solution:
      "Elements matching adblock filter rules may be hidden for users with adblockers. " +
      "This can affect ad revenue or hide legitimate content if element names/classes match ad patterns. " +
      "Consider renaming CSS classes that unintentionally match ad-blocking patterns (like .ad-*, .banner, .sponsor).",
    category: "blocking",
    subcategory: "ad",
    scope: "site",
    severity: "warning",
    weight: 3,
    optionsSchema,
    cloud: { service: "blocklist-check", unit: "site", creditFeature: "adblock_detect" },
  },

  run(ctx: RuleContext): RuleResult {
    const opts = optionsSchema.parse(ctx.options);
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<BlocklistCheckResponse>(ctx.cloudResults, "blocklist-check");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped" ? (envelope.skipReason ?? "not-prefetched") : "not-prefetched";
      checks.push({
        name: "adblock-elements",
        status: "skipped",
        message: "Adblock element-hiding check skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    // EasyPrivacy matches are reported by adblock/privacy-blocked.
    const matches = envelope.data.matches.filter(
      (m) => m.kind === "selector" && m.list === "easylist",
    );

    if (matches.length === 0) {
      checks.push({
        name: "adblock-elements",
        status: "pass",
        message: "No elements match common adblock filters",
      });
    } else {
      checks.push({
        name: "adblock-elements",
        status: "warn",
        message: `${matches.length} selector(s) on the site match adblock element-hiding rules`,
        items: matches.slice(0, opts.maxMatchesToReport).map((m) => ({
          id: m.value,
          label: m.rule ? `${m.value} matches "${m.rule}"` : m.value,
          meta: { rule: m.rule ?? null, list: m.list },
        })),
        details: { listsVersion: envelope.data.listsVersion },
      });
    }

    return { checks };
  },
};
