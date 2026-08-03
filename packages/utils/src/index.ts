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
  hasNonCrawlableUrlScheme,
  hasUnsafeUrlScheme,
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

export { isHttpOrHttpsUrl, safeRedirectFetch, type SafeRedirectResult } from "./safe-fetch";

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

export {
  extractNapSignal,
  emptyNapSignal,
  napAddressKey,
  napPhoneKey,
  NAP_BUSINESS_SCHEMA_TYPES,
  NAP_MAX_ADDRESS_CHARS,
  NAP_MAX_PHONES_PER_PAGE,
  NAP_NAME_SCHEMA_TYPES,
  NAP_PHONE_MIN_DIGITS,
  type NapSignal,
} from "./nap";

export { findClientRedirects } from "./client-redirects";

export { getRandomUserAgent } from "./user-agent";

export { timingSafeStringEqual } from "./crypto-compare";

export { normalizeHtmlForFingerprint } from "./fingerprint";

export { stripHtmlForText, type HtmlTextOptions } from "./html-text";

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
