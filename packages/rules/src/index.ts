// @squirrelscan/rules — rule definitions, runner, and categories

export * from "./types";
export * from "./collected-signals";
export * from "./endpoint-surface";
export * from "./categories";
export * from "./filter";
export * from "./rule-filter";
export * from "./wcag-filter";
export * from "./runner";
export * from "./rule-budget";
export * from "./probe-budget";
export * from "./merge";
export * from "./fold";
export * from "./resolution";
export * from "./loader";
export * from "./rule-options-check";
export * from "./ignore";
export * from "./plugins";
export * from "./cloud";
export * from "./discovery-probes";
export * from "./link-verdict-rules";
export {
  planSecretSources,
  type SecretSourceScript,
  type SecretSourceTarget,
} from "./security/secrets/sources";
export {
  APPLICABILITY_MIN_CONFIDENCE,
  type ApplicabilityVerdict,
  ruleApplies,
} from "./applicability";
export {
  setRequestAsync,
  clearRequestAsync,
  hasRequestTool,
  setLlmCall,
} from "./tools";
// The anchor graph `links/anchor-mismatch` judges. audit-engine's SiteQuery builds it with the
// SAME builder the rule's legacy path uses, so the two paths cannot diverge (#110).
export { AnchorGraphBuilder } from "./links/anchor-mismatch";
// Per-page generic/total anchor counts, shared by the site-wide density rule and the streaming SiteQuery (repo#1387).
export { countGenericAnchors } from "./shared/generic-anchor-phrases";
export type { GenericAnchorCount } from "./shared/generic-anchor-phrases";
// Which pages count as noindex, and the homepage exception, shared by the runner
// gate, the site rules and audit-engine's SiteData assembly (pub#457).
export {
  isSiteIndexable,
  noindexSource,
  skipsNoindexPages,
  type NoindexSource,
  type SiteIndexablePage,
} from "./shared/noindex";
// Page-time extractor for the social/asset-divergence page_features columns —
// audit-engine's extractPageFeatures calls the SAME code the rule's legacy path
// does, so the stored scalars and the re-derived ones can never diverge (#1371).
export {
  emptySiteChromeSignal,
  extractSiteChromeSignal,
  type SiteChromeSignal,
} from "./social/asset-divergence";
// Page-time reading level: audit-engine stores it on page_features and content/voice-consistency's
// legacy path derives it with the SAME function, so both paths agree by construction.
export { pageReadingLevel } from "./content/reading-level";
// Page-time terminology variant counts: same shared-function rule as the reading level above.
export { pageTerminologyVariants } from "./content/terminology-consistency";
// Page-time navigation link set: audit-engine stores it on page_features and
// links/nav-set-divergence's legacy path derives it with the SAME function.
export { pageNavLinkSet } from "./links/nav-set-divergence";
// Page-time main-text simhash: audit-engine stores it on page_features and content/near-duplicate's
// legacy path derives it with the SAME function, so both paths agree by construction.
export { pageContentSimhash } from "./content/near-duplicate";
// Per-page chrome fingerprint. `template-discontinuity` consumes it by fuzzy
// similarity; audit-engine reduces the SAME object to page_features' equality
// cluster key (#1949) and hands it to `buildCollectedPageSignal`, so one DOM
// walk per page feeds both.
export {
  buildBaseline,
  fingerprintPage,
  fingerprintWalkCount,
  resetFingerprintWalkCount,
  similarityToBaseline,
  type PageFingerprint,
  type SiteBaseline,
} from "./integrity/fingerprint";

// Domain re-exports
export * as content from "./content";
export * as links from "./links";
export * as images from "./images";
export * as schema from "./schema";
export * as security from "./security";
export * as integrity from "./integrity";
export * as perf from "./performance";
export * as reliability from "./reliability";
export * as social from "./social";
export * as crawl from "./crawl";
export * as url from "./url";
export * as mobile from "./mobile";
export {
  colorContrastRule,
  stylesheetBackgroundOf,
  stylesheetBackgroundSelectorsOf,
} from "./a11y/color-contrast";
export { reducedMotionRule, stylesheetMotionOf } from "./a11y/reduced-motion";
export {
  listWebAppManifestIconUrls,
  WEB_APP_MANIFEST_ICON_LIMIT,
} from "./mobile/web-app-manifest";
export * as legal from "./legal";
export * as local from "./local";
export * as video from "./video";
export * as analytics from "./analytics";
export * as eeat from "./eeat";

// Rule modules for iteration
export const RULE_MODULES = [
  "content",
  "links",
  "images",
  "schema",
  "security",
  "integrity",
  "perf",
  "reliability",
  "social",
  "crawl",
  "url",
  "mobile",
  "legal",
  "local",
  "video",
  "analytics",
  "eeat",
] as const;
export * from "./template-signature-reads";
