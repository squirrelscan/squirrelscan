// Re-export from package (canonical source)
export {
  type UrlPattern,
  type PatternStats,
  getUrlPattern,
  createPatternStats,
  getPatternStats,
  isPatternSampled,
  markPatternQueued,
  markPatternCrawled,
  getPatternCount,
  clearPatternStats,
} from "@squirrelscan/crawler";
