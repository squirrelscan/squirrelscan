// Utils module - re-exports from @squirrelscan/utils + local utils

export {
  normalizeUrl,
  isValidUrl,
  isInternalUrl,
  getOrigin,
  resolveUrl,
  shouldSkipUrl,
  isPageIndexable,
  type IndexabilityCheck,
  matchesExcludePattern,
  COMMON_EXCLUDE_PATTERNS,
  isRobotsTxtDisallowed,
  RICH_RESULT_TYPES,
  hasRichResultSchema,
  getRichResultTypes,
  isUUID,
  isShortId,
} from "@squirrelscan/utils";
