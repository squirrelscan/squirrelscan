// ai/site-metadata — Stage-0 site-profile resolution (cloud-backed, site-scope).
//
// This is the paid trigger for Stage 0 of the cloud decision graph: its `cloud`
// spec (`site-metadata`, 12 credits/run) is what makes the metadata service fire.
// The resolved per-domain profile (site type, business category, country,
// audience, identity, contacts, socials, domain age) gates every downstream
// cloud feature AND informs which audit rules apply (`appliesWhen`). Report-only
// and NON-SCORING (weight 0) — it summarizes the profile and never fails.

import type { SiteMetadataResponse } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { humanizeCloudSkip, readCloudResult } from "../cloud";

export const siteMetadataRule: Rule = {
  meta: {
    id: "ai/site-metadata",
    name: "Site Profile",
    description:
      "Resolves the durable per-domain site profile (type, business category, country, audience, identity, contacts, socials, domain age) — the root of the audit decision graph.",
    solution:
      "Informational: the resolved profile anchors which cloud features and audit rules apply to this site. If the classification looks wrong, the site's purpose/identity may not be coming through — sharpen the homepage value proposition, Organization/LocalBusiness JSON-LD, og/twitter meta, and contact details.",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 0, // report-only / non-scoring
    cloud: { service: "site-metadata", unit: "site", creditFeature: "site_metadata" },
  },

  run(ctx: RuleContext): RuleResult {
    const checks: CheckResult[] = [];

    const envelope = readCloudResult<SiteMetadataResponse>(ctx.cloudResults, "site-metadata");
    if (!envelope || envelope.status === "skipped" || !envelope.data) {
      const reason =
        envelope?.status === "skipped"
          ? (envelope.skipReason ?? "not-prefetched")
          : "not-prefetched";
      checks.push({
        name: "site-metadata",
        status: "skipped",
        message: "Site profile resolution skipped",
        skipReason: humanizeCloudSkip(reason),
      });
      return { checks };
    }

    const meta = envelope.data;

    // Build a compact human-readable summary of the profile.
    const parts: string[] = [`type "${meta.siteType}"`];
    if (meta.businessCategory) parts.push(`category "${meta.businessCategory}"`);
    if (meta.primaryCountry) parts.push(`country ${meta.primaryCountry}`);
    if (meta.audienceScope) parts.push(`audience ${meta.audienceScope}`);
    if (meta.domainAgeDays != null) {
      const years = Math.floor(meta.domainAgeDays / 365);
      parts.push(years >= 1 ? `domain ~${years}y old` : `domain ${meta.domainAgeDays}d old`);
    }

    checks.push({
      name: "site-metadata",
      status: "info",
      message: `Site profile: ${parts.join(", ")} (${meta.confidence} confidence)`,
      value: meta.siteType,
      details: {
        siteType: meta.siteType,
        businessCategory: meta.businessCategory ?? null,
        primaryCountry: meta.primaryCountry ?? null,
        audienceScope: meta.audienceScope ?? null,
        entityName: meta.entityName ?? null,
        entityType: meta.entityType ?? null,
        isYMYL: meta.isYMYL,
        isLocalBusiness: meta.isLocalBusiness,
        confidence: meta.confidence,
        domainAgeDays: meta.domainAgeDays ?? null,
        registrar: meta.registrar ?? null,
        contactCount: meta.contacts?.length ?? 0,
        socialCount: meta.socials?.length ?? 0,
        rationale: meta.rationale ?? null,
      },
    });

    return { checks };
  },
};
