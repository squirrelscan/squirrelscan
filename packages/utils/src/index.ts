// @squirrelscan/utils - shared utilities

export {
  normalizeUrl,
  isValidUrl,
  isInternalUrl,
  getOrigin,
  getHostname,
  getPathname,
  resolveUrl,
  coerceSchemelessUrl,
  shouldSkipUrl,
  parseUserUrl,
  isLocalhost,
  isLoopbackHost,
  isValidDomain,
  hasNonHttpScheme,
  getProjectNameContext,
  setReservedNames,
  type UrlParseResult,
  type DomainValidationResult,
  type ProjectNameContext,
} from "./url";

export { getAttrCI, hasAttrCI, querySelectorAllByAttrCI, querySelectorByAttrValueCI } from "./dom";

export { isUUID, isShortId } from "./validation";

export {
  headersForRedirect,
  isValidHeaderName,
  isValidHeaderValue,
  recordToHeaders,
} from "./headers";

export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_DOCUMENT_BODY_BYTES,
  readBodyCapped,
} from "./response-body";

export { isPageIndexable, type IndexabilityCheck } from "./indexable";

export { matchesExcludePattern, COMMON_EXCLUDE_PATTERNS } from "./patterns";

export { isRobotsTxtDisallowed } from "./robots-txt";

export {
  RICH_RESULT_TYPES,
  hasRichResultSchema,
  getRichResultTypes,
  flattenJsonLdNodes,
} from "./schema-rich-results";

export { findClientRedirects } from "./client-redirects";

export { getRandomUserAgent } from "./user-agent";

export { timingSafeStringEqual } from "./crypto-compare";

export { normalizeHtmlForFingerprint } from "./fingerprint";

export { chunk, mapWithConcurrency } from "./concurrency";

export { matchesRulePattern } from "./rule-pattern";

export {
  type CacheControl,
  parseCacheControl,
  cacheControlLifetimeSeconds,
  expiresLifetimeSeconds,
} from "./cache-control";

export {
  detectWaf,
  detectWafFromHeaders,
  detectWafFromContent,
  isLikelyWafBlock,
  getWafProviderName,
  type WafProvider,
  type WafDetectionResult,
} from "./waf";
