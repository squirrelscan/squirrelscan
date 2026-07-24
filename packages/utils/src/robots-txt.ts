/**
 * robots.txt URL checking utilities
 */

import type { RobotsTxtData, RobotsRule } from "@squirrelscan/core-contracts";

import { getPathname } from "./url";

/**
 * Check if a URL is disallowed by robots.txt rules
 *
 * @param url - URL to check
 * @param robotsTxt - Parsed robots.txt data
 * @param userAgent - User-agent to check (default: "Googlebot")
 * @returns true if URL is disallowed, false if allowed
 */
export function isRobotsTxtDisallowed(
  url: string,
  robotsTxt: RobotsTxtData | null,
  userAgent = "Googlebot"
): boolean {
  if (!robotsTxt?.exists) return false;

  const pathname = getPathname(url);
  if (!pathname) return false;

  // Find matching user-agent rules (priority: exact match > wildcard *)
  let matchedRules = robotsTxt.rules.find(
    (r: { userAgent: string }) => r.userAgent === userAgent
  );

  // Fallback to wildcard if specific user-agent not found
  if (!matchedRules) {
    matchedRules = robotsTxt.rules.find(
      (r: { userAgent: string }) => r.userAgent === "*"
    );
  }

  if (!matchedRules) return false;

  // Check disallow/allow rules in order
  // First matching rule wins
  for (const rule of matchedRules.rules) {
    if (pathname.startsWith(rule.path)) {
      return rule.type === "disallow";
    }
  }

  // Default: allowed
  return false;
}

/**
 * Parse robots.txt content into structured data
 */
export function parseRobotsTxt(content: string, url: string): RobotsTxtData {
  const lines = content.split("\n");
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  const errors: string[] = [];

  let currentUserAgent: string | null = null;
  let currentRules: { type: "allow" | "disallow"; path: string }[] = [];
  let currentCrawlDelay: number | undefined;

  const flushCurrentRule = () => {
    if (currentUserAgent && currentRules.length > 0) {
      rules.push({
        userAgent: currentUserAgent,
        rules: [...currentRules],
        crawlDelay: currentCrawlDelay,
      });
    }
    currentRules = [];
    currentCrawlDelay = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const directive = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();

    switch (directive) {
      case "user-agent":
        flushCurrentRule();
        currentUserAgent = value;
        break;
      case "disallow":
        if (currentUserAgent && value) {
          currentRules.push({ type: "disallow", path: value });
        }
        break;
      case "allow":
        if (currentUserAgent && value) {
          currentRules.push({ type: "allow", path: value });
        }
        break;
      case "crawl-delay":
        if (currentUserAgent) {
          const delay = Number.parseFloat(value);
          if (!Number.isNaN(delay)) {
            currentCrawlDelay = delay;
          }
        }
        break;
      case "sitemap":
        if (value) {
          sitemaps.push(value.trim());
        }
        break;
    }
  }

  flushCurrentRule();

  return {
    exists: true,
    url,
    content,
    sizeBytes: new Blob([content]).size,
    sitemaps,
    rules,
    errors,
  };
}
