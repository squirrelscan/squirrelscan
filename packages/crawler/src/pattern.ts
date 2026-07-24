// URL pattern detection for surface mode crawling
// Identifies variable segments to group similar URLs and avoid over-crawling

// Pattern tracking types
export interface UrlPattern {
  template: string;
  crawledCount: number;
  queuedCount: number;
}

export interface PatternStats {
  patterns: Map<string, UrlPattern>;
}

// Regex patterns for segment classification
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{12,}$/i; // 12+ hex chars (short hashes, long IDs)
const SEMVER = /^\d+\.\d+(\.\d+)*([.-]\S*)?$/; // semver-like: 1.0.0, 0.0.34, 2.1.0-beta
const YEAR_SEGMENT = /^\d{4}$/; // 4 digits = likely a year
const MONTH_DAY_SEGMENT = /^(0?[1-9]|1[0-2]|[12]\d|3[01])$/; // 1-31 = likely month/day
const DATE_FULL = /^\d{4}-\d{2}-\d{2}$/; // ISO date
const NUMERIC_ID = /^\d+$/; // Any numeric (checked after date patterns)
const SLUG_LIKE = /^[a-z0-9]+(-[a-z0-9]+){2,}$/; // lowercase with 2+ hyphens

type SegmentType = "static" | "id" | "slug" | "date" | "version";

/**
 * Classify a path segment as static or variable
 */
function classifySegment(segment: string): SegmentType {
  // UUIDs first (most specific)
  if (UUID.test(segment)) return "id";

  // Long hex hashes (12+ chars, only hex characters)
  if (HEX_HASH.test(segment) && segment.length >= 12) return "id";

  // Semver-like version strings (1.0.0, 0.0.34, 2.1.0-beta) — before other checks
  if (SEMVER.test(segment)) return "version";

  // ISO date format (2024-01-15)
  if (DATE_FULL.test(segment)) return "date";

  // Year segment (4 digits, 1900-2100 range)
  if (YEAR_SEGMENT.test(segment)) {
    const num = Number.parseInt(segment, 10);
    if (num >= 1900 && num <= 2100) return "date";
  }

  // Month/day segment (1-31)
  if (MONTH_DAY_SEGMENT.test(segment)) return "date";

  // Pure numeric IDs (5+ digits are likely IDs, not dates)
  if (NUMERIC_ID.test(segment) && segment.length >= 5) return "id";

  // Short numeric could be pagination or small IDs
  if (NUMERIC_ID.test(segment)) return "id";

  // Slug-like segments (lowercase with multiple hyphens, min length)
  if (SLUG_LIKE.test(segment) && segment.length > 15) return "slug";

  return "static";
}

/**
 * Extract URL pattern template from a URL
 * /blog/2024/01/my-awesome-post -> /blog/{date}/{date}/{slug}
 * /products/12345 -> /products/{id}
 */
export function getUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (segments.length === 0) return "/";

    const patternSegments = segments.map((seg) => {
      const type = classifySegment(seg);
      return type === "static" ? seg : `{${type}}`;
    });

    return "/" + patternSegments.join("/");
  } catch {
    return url; // Fallback to full URL if parsing fails
  }
}

/**
 * Create pattern stats tracker
 */
export function createPatternStats(): PatternStats {
  return { patterns: new Map() };
}

/**
 * Get pattern stats for a URL
 */
export function getPatternStats(
  stats: PatternStats,
  url: string
): UrlPattern | null {
  const pattern = getUrlPattern(url);
  return stats.patterns.get(pattern) ?? null;
}

/**
 * Check if pattern has been sufficiently sampled
 */
export function isPatternSampled(
  stats: PatternStats,
  url: string,
  limit: number
): boolean {
  const pattern = getUrlPattern(url);
  const entry = stats.patterns.get(pattern);
  return entry ? entry.crawledCount >= limit : false;
}

/**
 * Mark URL as queued for its pattern
 */
export function markPatternQueued(stats: PatternStats, url: string): void {
  const pattern = getUrlPattern(url);
  const entry = stats.patterns.get(pattern) ?? {
    template: pattern,
    crawledCount: 0,
    queuedCount: 0,
  };
  entry.queuedCount++;
  stats.patterns.set(pattern, entry);
}

/**
 * Mark URL as crawled for its pattern
 */
export function markPatternCrawled(stats: PatternStats, url: string): void {
  const pattern = getUrlPattern(url);
  const entry = stats.patterns.get(pattern) ?? {
    template: pattern,
    crawledCount: 0,
    queuedCount: 0,
  };
  entry.crawledCount++;
  entry.queuedCount = Math.max(0, entry.queuedCount - 1);
  stats.patterns.set(pattern, entry);
}

/**
 * Get total unique patterns tracked
 */
export function getPatternCount(stats: PatternStats): number {
  return stats.patterns.size;
}

/**
 * Clear all pattern stats
 */
export function clearPatternStats(stats: PatternStats): void {
  stats.patterns.clear();
}
