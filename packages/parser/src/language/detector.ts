// Content-language detection: the interface every detector implements, the
// abstention floor, and tag normalisation (squirrelscan/repo#2360).
//
// This is about the language a page is WRITTEN in, read from its text. The
// declared language (`<html lang>`, `meta content-language`) is
// `detectLanguage(doc)` in extractors/content.ts, which is a different thing.

/** One detection: a BCP 47 primary language subtag and the detector's confidence in [0, 1]. */
export interface DetectedLanguage {
  /** Lowercase BCP 47 primary language subtag: ISO 639-1 where one exists ("en", "de"), else ISO 639-3 ("ceb"). */
  lang: string;
  /** Detector-specific confidence in [0, 1]. Comparable within one detector only. */
  confidence: number;
}

/**
 * A content-language detector. `detectLanguage` returns null when it cannot
 * name a language (empty text, digits only, below the floor). Implementations
 * are synchronous and pure so a rule can call one without awaiting.
 */
export interface LanguageDetector {
  /** Stable id, used by the benchmark output and in traces. */
  readonly id: string;
  detectLanguage(text: string): DetectedLanguage | null;
}

/**
 * Lowest confidence at which a detection is reported; below it the detector
 * abstains (returns null).
 *
 * TBD (squirrelscan/repo#2360): PLACEHOLDER value pending the corpus benchmark.
 * Run `bun benchmarks/harness/content-language.ts <corpus-dir>` where the
 * corpus lives and set this to the reported `suggestedFloor.minConfidence`.
 */
export const CONTENT_LANGUAGE_MIN_CONFIDENCE = 0.02;

/**
 * Shortest text (in characters, after whitespace collapse) a detection is
 * attempted on; shorter text abstains. Trigram detectors are unreliable on a
 * few words.
 *
 * TBD (squirrelscan/repo#2360): PLACEHOLDER value pending the corpus benchmark
 * (`suggestedFloor.minChars`).
 */
export const CONTENT_LANGUAGE_MIN_CHARS = 40;

/**
 * Most characters handed to a detector. Trigram detectors converge well before
 * this, and capping keeps per-page cost flat on very long pages.
 */
export const CONTENT_LANGUAGE_MAX_CHARS = 4096;

export interface LanguageFloor {
  minConfidence: number;
  minChars: number;
}

export const DEFAULT_LANGUAGE_FLOOR: LanguageFloor = {
  minConfidence: CONTENT_LANGUAGE_MIN_CONFIDENCE,
  minChars: CONTENT_LANGUAGE_MIN_CHARS,
};

/** Collapse whitespace and cap the length, the text every detector sees. */
export function prepareLanguageText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > CONTENT_LANGUAGE_MAX_CHARS
    ? collapsed.slice(0, CONTENT_LANGUAGE_MAX_CHARS)
    : collapsed;
}

/**
 * Wrap a detector so it abstains on short text and on detections below the
 * confidence floor. The inner detector sees the prepared text.
 */
export function withLanguageFloor(
  inner: LanguageDetector,
  floor: LanguageFloor = DEFAULT_LANGUAGE_FLOOR,
): LanguageDetector {
  return {
    id: inner.id,
    detectLanguage(text: string): DetectedLanguage | null {
      const prepared = prepareLanguageText(text);
      if (prepared.length < floor.minChars) return null;
      const result = inner.detectLanguage(prepared);
      // Written so a NaN confidence abstains too.
      if (!result || Number.isNaN(result.confidence) || result.confidence < floor.minConfidence) return null;
      return result;
    },
  };
}

// Deprecated or macrolanguage tags a corpus or a detector may use, folded to
// the tag detectors emit so a label and a prediction compare equal.
const TAG_ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  ji: "yi",
  jw: "jv",
  no: "nb",
};

/**
 * Normalise a language tag to its lowercase primary subtag, with deprecated
 * aliases folded ("en-US" -> "en", "iw" -> "he", "no" -> "nb"). Returns null for
 * an empty or malformed tag.
 */
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary || !/^[a-z]{2,3}$/.test(primary)) return null;
  return TAG_ALIASES[primary] ?? primary;
}
