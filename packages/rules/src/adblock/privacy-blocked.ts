// adblock/privacy-blocked - resources/selectors matched by EasyPrivacy
// (cloud-backed, site-scope — tracking-specific list, separate from EasyList)

import { z } from "zod";

import type { BlocklistCheckResponse } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";
import { findSourcePages } from "./blocked-links";

export const optionsSchema = z.object({
  maxMatchesToReport: z
    .number()
    .default(10)
    .describe("Maximum privacy-blocked matches to report in detail"),
});

export const privacyBlockedRule: Rule = {
  meta: {
    id: "adblock/privacy-blocked",
    name: "Privacy Filter Matches",
    description:
      "Checks for trackers and analytics that privacy filter lists (EasyPrivacy) would block",
    solution:
      "Resources matching EasyPrivacy are blocked by privacy-focused browsers and extensions (uBlock Origin, Brave, Firefox strict mode). " +
      "Analytics, session replay, and tracking pixels on these domains will silently fail for those visitors, skewing your data. " +
      "Consider first-party or privacy-respecting analytics so measurement survives tracker blocking.",
    category: "blocking",
    subcategory: "privacy",
    scope: "site",
    severity: "warning",
    weight: 2,
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
        name: "privacy-blocked",
        status: "skipped",
        message: "Privacy filter check skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const matches = envelope.data.matches.filter((m) => m.list === "easyprivacy");

    if (matches.length === 0) {
      checks.push({
        name: "privacy-blocked",
        status: "pass",
        message: "No resources match EasyPrivacy tracking filters",
      });
    } else {
      checks.push({
        name: "privacy-blocked",
        status: "warn",
        message: `${matches.length} resource(s) would be blocked by privacy filters (EasyPrivacy)`,
        items: matches.slice(0, opts.maxMatchesToReport).map((m) => ({
          id: m.value,
          label: m.rule ? `${m.value} matches "${m.rule}"` : m.value,
          sourcePages: m.kind === "url" ? findSourcePages(ctx, m.value) : undefined,
          meta: { rule: m.rule ?? null, list: m.list, kind: m.kind },
        })),
        details: { listsVersion: envelope.data.listsVersion },
      });
    }

    return { checks };
  },
};
