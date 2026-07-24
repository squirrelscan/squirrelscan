// Stage-1 cloud gating POLICY (CLI-owned). The audit engine's prefetch stays
// policy-free: it calls this predicate per remaining service once Stage-0 has
// resolved the site profile, and removes any service it returns false for
// BEFORE the per-audit cap — so a non-applicable paid feature never charges and
// its budget frees up for the rest.
//
// Contract: DEFAULT to `true` for every service this policy doesn't explicitly
// gate. Adding a new cloud service must NOT silently suppress it — only the
// services listed here are gated, everything else runs as before (backward-compat).

import type {
  CloudServiceId,
  SiteMetadata,
  SiteType,
} from "@squirrelscan/core-contracts";

/**
 * Site types where keyword/content-gap analysis is noise: a personal site or a
 * portfolio isn't competing for organic keywords, so the gap services are pure
 * spend with no signal.
 */
const GAP_SKIP_SITE_TYPES: ReadonlySet<SiteType> = new Set([
  "personal",
  "portfolio",
]);

/**
 * Site types where authority/EEAT signals genuinely matter even absent the YMYL
 * flag — editorial/medical content is judged on author + citation strength.
 */
const AUTHORITY_SITE_TYPES: ReadonlySet<SiteType> = new Set([
  "blog",
  "news",
  "healthcare_provider",
]);

/**
 * Decide whether a downstream cloud service should run for this resolved site
 * profile. Pure + side-effect free. Unknown/ungated services → `true`.
 */
export const gateStage1 = (
  meta: SiteMetadata,
  service: CloudServiceId
): boolean => {
  switch (service) {
    case "keyword-gaps":
    case "content-gaps":
      // Personal sites / portfolios aren't chasing organic share — skip the gaps.
      return !GAP_SKIP_SITE_TYPES.has(meta.siteType);

    case "authority-signals":
      // Only worth paying for where authority is a ranking/trust factor: YMYL
      // sites, or editorial/medical site types.
      return meta.isYMYL || AUTHORITY_SITE_TYPES.has(meta.siteType);

    default:
      // Every other service runs — never let a new service be gated silently.
      return true;
  }
};
