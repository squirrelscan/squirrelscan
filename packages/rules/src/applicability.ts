// Rule-applicability layer — a pure, run-time gate consulted by the runner.
//
// A rule may declare `meta.appliesWhen` (see `RuleApplicability` in types.ts).
// `ruleApplies()` decides whether the rule should run for the current Stage-0
// site-metadata profile. This is the backward-compatibility + graceful-degradation
// contract — get it EXACTLY right:
//
//   - no `appliesWhen`           → applies   (safety rules / unannotated rules run)
//   - no `meta` (undefined)      → applies   (offline / free / no-credits → run as today)
//   - meta.confidence below      → applies   (don't gate on low-confidence guesses)
//     APPLICABILITY_MIN_CONFIDENCE
//   - otherwise: AND across every declared key (OR within each list). The FIRST
//     failing condition returns `{ applies:false, reason }`; if all pass, applies.

import type { SiteMetadata } from "@squirrelscan/core-contracts";

import type { RuleApplicability } from "./types";

/**
 * Minimum metadata confidence at which `appliesWhen` gating engages. Below this
 * the profile is treated as too uncertain to suppress any rule — `ruleApplies`
 * returns `{ applies: true }` regardless of declaration (mitigates the
 * "misclassification silently suppresses real issues" risk).
 */
export const APPLICABILITY_MIN_CONFIDENCE: SiteMetadata["confidence"] = "medium";

/** Confidence ordering — used to compare against the min threshold. */
const CONFIDENCE_RANK: Record<SiteMetadata["confidence"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export type ApplicabilityVerdict = { applies: true } | { applies: false; reason: string };

/**
 * Decide whether a rule with the given `appliesWhen` declaration applies to the
 * resolved site-metadata profile. Pure — no I/O, no globals.
 */
export function ruleApplies(
  appliesWhen: RuleApplicability | undefined,
  meta: SiteMetadata | undefined,
): ApplicabilityVerdict {
  // No declaration → always applies (safety rules + unannotated rules).
  if (!appliesWhen) return { applies: true };

  // No resolved metadata → run as today (offline / free / no-credits / no-consent).
  if (!meta) return { applies: true };

  // Don't gate on a low-confidence classification.
  if (CONFIDENCE_RANK[meta.confidence] < CONFIDENCE_RANK[APPLICABILITY_MIN_CONFIDENCE]) {
    return { applies: true };
  }

  // Boolean requirements — gate when the flag is required but the site lacks it.
  if (appliesWhen.requiresYMYL && !meta.isYMYL) {
    return { applies: false, reason: "site is not Your-Money-or-Your-Life (YMYL)" };
  }
  if (appliesWhen.requiresLocalBusiness && !meta.isLocalBusiness) {
    return { applies: false, reason: "site is not a local business" };
  }
  if (appliesWhen.requiresOwnership && !meta.hasOwnershipVerified) {
    return { applies: false, reason: "site ownership is not verified" };
  }

  // Site type — gate when declared and the resolved type is not in the list.
  if (appliesWhen.siteTypes && !appliesWhen.siteTypes.includes(meta.siteType)) {
    return { applies: false, reason: `site type is "${meta.siteType}"` };
  }

  // Business category — only gate when the site HAS a category and it's excluded
  // (a null/unknown category should not suppress a category-targeted rule).
  if (
    appliesWhen.businessCategories &&
    meta.businessCategory &&
    !appliesWhen.businessCategories.includes(meta.businessCategory)
  ) {
    return { applies: false, reason: `business category is "${meta.businessCategory}"` };
  }

  // Country — only gate when a primary country is known and it's excluded.
  if (
    appliesWhen.countries &&
    meta.primaryCountry &&
    !appliesWhen.countries.includes(meta.primaryCountry)
  ) {
    return { applies: false, reason: `primary country is "${meta.primaryCountry}"` };
  }

  // Audience — gate when declared and there is NO overlap with the site's
  // audienceScope. Compared case-sensitively against `audienceScope`
  // ("global" | "national" | "regional" | "local"); languages are NOT consulted.
  if (appliesWhen.audiences) {
    const siteAudiences = new Set<string>();
    if (meta.audienceScope) siteAudiences.add(meta.audienceScope);
    // Only gate on audience when the site actually declares one; an unknown
    // audience should not suppress an audience-targeted rule.
    if (siteAudiences.size > 0) {
      const overlap = appliesWhen.audiences.some((a) => siteAudiences.has(a));
      if (!overlap) {
        return {
          applies: false,
          reason: `audience is "${meta.audienceScope ?? "unknown"}"`,
        };
      }
    }
  }

  return { applies: true };
}
