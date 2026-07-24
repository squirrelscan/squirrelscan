/**
 * Indexability utilities for determining if pages can be indexed by search engines
 */

import type { ParsedPage, RobotsTxtData } from "@squirrelscan/core-contracts";

import { isRobotsTxtDisallowed } from "./robots-txt";

/**
 * Result of indexability check with detailed reasons
 */
export interface IndexabilityCheck {
  /** Whether the page is indexable */
  isIndexable: boolean;
  /** Reasons why page is not indexable (empty if indexable) */
  reasons: string[];
}

/**
 * Check if a page is indexable by search engines
 *
 * A page is considered non-indexable if:
 * - robots meta tag contains "noindex"
 * - X-Robots-Tag HTTP header contains "noindex"
 * - robots.txt disallows the URL (if robotsTxt provided)
 *
 * @param parsed - Parsed page data
 * @param headers - HTTP response headers
 * @param url - Page URL (required for robots.txt check)
 * @param robotsTxt - Parsed robots.txt data (optional)
 * @returns IndexabilityCheck object with isIndexable boolean and reasons array
 */
export function isPageIndexable(
  parsed: ParsedPage | null,
  headers?: Record<string, string>,
  url?: string,
  robotsTxt?: RobotsTxtData | null
): IndexabilityCheck {
  const reasons: string[] = [];

  if (!parsed) {
    // If page couldn't be parsed (e.g., error page), consider not indexable
    return { isIndexable: false, reasons: ["unparseable"] };
  }

  // Check robots meta tag
  const robotsMeta = parsed.meta?.robots?.toLowerCase() || "";
  if (robotsMeta.includes("noindex")) {
    reasons.push("meta:noindex");
  }

  // Check X-Robots-Tag HTTP header
  if (headers) {
    const xRobotsTag = headers["x-robots-tag"]?.toLowerCase() || "";
    if (xRobotsTag.includes("noindex")) {
      reasons.push("header:noindex");
    }
  }

  // Check robots.txt disallow rules
  if (url && robotsTxt && isRobotsTxtDisallowed(url, robotsTxt)) {
    reasons.push("robots.txt:disallowed");
  }

  return {
    isIndexable: reasons.length === 0,
    reasons,
  };
}
