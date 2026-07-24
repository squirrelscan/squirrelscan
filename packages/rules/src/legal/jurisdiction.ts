// legal/jurisdiction - shared jurisdiction detection from Stage-0 site metadata.
//
// Pure helpers consumed by the privacy/legal rules to decide whether a stricter
// (GDPR / CCPA) regime applies, so a missing privacy policy / cookie consent is
// treated as more serious. All return `false` when no metadata is resolved
// (offline / free / low-confidence) — callers therefore behave exactly as today.

import type { SiteMetadata } from "@squirrelscan/core-contracts";

/** EU/EEA + UK ISO-3166 alpha-2 codes that fall under GDPR / UK-GDPR. */
const GDPR_COUNTRIES = new Set<string>([
  // EU member states
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  // EEA (non-EU) + UK (UK-GDPR)
  "IS",
  "LI",
  "NO",
  "GB",
]);

/**
 * True when the resolved profile points at a GDPR / UK-GDPR jurisdiction. Uses
 * `primaryCountry` (authoritative) and treats a "global" audience as in-scope
 * (a global site almost certainly serves EU visitors). Returns false without
 * metadata so the caller keeps its default behaviour.
 */
export function isGdprJurisdiction(meta: SiteMetadata | undefined): boolean {
  if (!meta) return false;
  if (meta.primaryCountry && GDPR_COUNTRIES.has(meta.primaryCountry.toUpperCase())) {
    return true;
  }
  // A globally-scoped audience reaches EU users; require GDPR-grade handling.
  if (meta.audienceScope === "global") return true;
  return false;
}

/**
 * True when the resolved profile points at a CCPA jurisdiction (US — California
 * specifically, but country granularity is the best signal we have, so any US
 * site is treated as CCPA-relevant). Returns false without metadata.
 */
export function isCcpaJurisdiction(meta: SiteMetadata | undefined): boolean {
  if (!meta) return false;
  return meta.primaryCountry?.toUpperCase() === "US";
}

/**
 * A short human label for the strictest privacy regime that applies, or null.
 * Used to enrich rule messages when escalating.
 */
export function privacyRegimeLabel(meta: SiteMetadata | undefined): string | null {
  if (isGdprJurisdiction(meta)) return "GDPR";
  if (isCcpaJurisdiction(meta)) return "CCPA";
  return null;
}
