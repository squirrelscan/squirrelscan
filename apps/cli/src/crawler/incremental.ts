// Re-export from @squirrelscan/crawler package
export {
  type ChangeDetectionMeta,
  type ConditionalHeaders,
  type ChangeStatus,
  computeContentHash,
  computeNormalizedContentHash,
  buildConditionalHeaders,
  hasConditionalHeaders,
  extractChangeDetection,
  extractChangeDetectionNormalized,
  compareChangeDetection,
  hasContentChanged,
  isNotModifiedResponse,
  shouldSkipParsing,
  parseCacheControl,
  isCacheFresh,
  changeDetection,
} from "@squirrelscan/crawler";
