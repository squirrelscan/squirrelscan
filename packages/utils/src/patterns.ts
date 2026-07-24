/**
 * Pattern matching utilities for URL filtering
 */

import { getPathname } from "./url";

/**
 * Check if URL matches any of the provided exclusion patterns
 *
 * Supports three pattern types:
 * 1. Regex patterns: `regex:^/blog/\\d{4}/` - Tests pathname against regex (flags supported with :flags suffix)
 * 2. Exact segment patterns: `/thank-you/` - Matches exact path or as prefix (trailing slash required)
 * 3. Substring patterns: `/thank-you` - Simple substring match (backward compatible)
 *
 * @param url - URL to check
 * @param patterns - Array of patterns (substring, exact segment, or regex)
 * @returns true if URL matches any pattern
 *
 * @example
 * ```ts
 * matchesExcludePattern("https://example.com/thank-you", ["/thank-you"])        // true (substring)
 * matchesExcludePattern("https://example.com/thank-you-note", ["/thank-you/"])  // false (exact segment)
 * matchesExcludePattern("https://example.com/blog/2024/post", ["regex:^/blog/\\d{4}/"])  // true (regex)
 * matchesExcludePattern("https://example.com/Blog/post", ["regex:^/blog:i"])  // true (case-insensitive)
 * ```
 */
export function matchesExcludePattern(
  url: string,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;

  const pathname = getPathname(url) || url;

  return patterns.some((pattern) => {
    if (!pattern) return false;

    // Regex pattern: regex:^/blog/\d{4}/ or regex:^/blog:i (with flags)
    if (pattern.startsWith("regex:")) {
      let regexStr = pattern.slice(6); // Remove "regex:" prefix
      let flags = "";

      // Check for flags suffix (pattern:flags format)
      // Flags must be at the end after a colon and be valid regex flags
      const colonIndex = regexStr.lastIndexOf(":");
      if (colonIndex > 0) {
        const potentialFlags = regexStr.slice(colonIndex + 1);
        if (/^[gimsuvy]+$/.test(potentialFlags)) {
          flags = potentialFlags;
          regexStr = regexStr.slice(0, colonIndex);
        }
      }

      try {
        const regex = new RegExp(regexStr, flags);
        return regex.test(pathname);
      } catch {
        // Invalid regex - log warning but don't crash
        console.warn(`[patterns] Invalid regex pattern: ${pattern}`);
        return false;
      }
    }

    // Exact segment match: /thank-you/ (must start and end with /)
    if (
      pattern.startsWith("/") &&
      pattern.endsWith("/") &&
      pattern.length > 1
    ) {
      const pathToMatch = pattern.slice(0, -1); // Remove trailing slash
      // Match exact path or as directory prefix
      return pathname === pathToMatch || pathname.startsWith(pattern);
    }

    // Default: substring match (backward compatible)
    return url.includes(pattern);
  });
}

/**
 * Common exclusion patterns for pages that are intentionally dead-ends or orphans
 */
export const COMMON_EXCLUDE_PATTERNS = {
  deadEnd: [
    "/thank-you",
    "/confirmation",
    "/download",
    "/success",
    "/submitted",
  ],
  orphan: ["/landing-page", "/campaign", "/promo"],
} as const;
