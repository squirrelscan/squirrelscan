// Content-language detection (squirrelscan/repo#2360). The benchmark helpers in
// ./benchmark.ts are deliberately not re-exported: they are a measurement tool
// for benchmarks/harness/content-language.ts, not part of the product.

export {
  CONTENT_LANGUAGE_MAX_CHARS,
  CONTENT_LANGUAGE_MIN_CHARS,
  CONTENT_LANGUAGE_MIN_CONFIDENCE,
  DEFAULT_LANGUAGE_FLOOR,
  normalizeLanguageTag,
  prepareLanguageText,
  withLanguageFloor,
  type DetectedLanguage,
  type LanguageDetector,
  type LanguageFloor,
} from "./detector";
export {
  createFrancDetector,
  FRANC_ISO6391,
  FRANC_WEB_LANGUAGES,
  type FrancDetectorOptions,
} from "./franc";
export {
  CONTENT_LANGUAGE_MAX_BLOCKS,
  createContentLanguageView,
  defaultContentLanguageDetector,
  detectContentLanguage,
  mainContentLanguageText,
  type ContentLanguageBlock,
  type ContentLanguageSource,
  type ContentLanguageView,
} from "./page";
