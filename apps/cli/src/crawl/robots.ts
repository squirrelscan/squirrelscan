// Fetch robots.txt processor
// Fetches and parses robots.txt for a site

import { Effect, pipe } from "effect";

import type { ContextRef } from "@/infra/context";
import type { RobotsTxtData, RobotsRule } from "@/types";

import { getContext, updateContext, setRobotsTxt } from "@/infra/context";
import { FetchError } from "@/infra/errors";
import { request, type RequestError } from "@/tools/request";

// ============================================
// ROBOTS.TXT PARSING
// ============================================

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

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Parse directive
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

  // Flush last rule
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

/**
 * Check if URL is allowed by robots.txt
 */
export function isUrlAllowed(
  robotsTxt: RobotsTxtData,
  url: string,
  userAgent: string
): boolean {
  if (!robotsTxt.exists) return true;

  // Find matching rules
  const path = new URL(url).pathname;
  const matchingRules: RobotsRule[] = [];

  for (const rule of robotsTxt.rules) {
    // Check if user agent matches
    const ua = rule.userAgent.toLowerCase();
    if (ua === "*" || userAgent.toLowerCase().includes(ua)) {
      matchingRules.push(rule);
    }
  }

  // Check all matching rules
  for (const rule of matchingRules) {
    for (const r of rule.rules) {
      // Simple path matching
      if (path.startsWith(r.path) || r.path === "/") {
        return r.type === "allow";
      }
    }
  }

  return true; // Default allow
}

// ============================================
// FETCH ROBOTS.TXT
// ============================================

/**
 * Fetch robots.txt from site
 */
export function fetchRobotsTxt(
  baseUrl: string,
  userAgent: string
): Effect.Effect<RobotsTxtData, never, never> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();

  return pipe(
    request(robotsUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/plain",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    }).pipe(
      Effect.mapError((error: RequestError) =>
        FetchError.network(robotsUrl, error.message)
      )
    ),
    Effect.flatMap((response) => {
      if (response.status === 404) {
        // No robots.txt - return empty
        return Effect.succeed<RobotsTxtData>({
          exists: false,
          url: robotsUrl,
          content: null,
          sizeBytes: 0,
          sitemaps: [],
          rules: [],
          errors: [],
        });
      }

      if (!response.ok) {
        return Effect.succeed<RobotsTxtData>({
          exists: false,
          url: robotsUrl,
          content: null,
          sizeBytes: 0,
          sitemaps: [],
          rules: [],
          errors: [`HTTP ${response.status}`],
        });
      }

      return Effect.tryPromise({
        try: () => response.text(),
        catch: (error) =>
          FetchError.network(robotsUrl, (error as Error).message),
      }).pipe(Effect.map((content) => parseRobotsTxt(content, robotsUrl)));
    }),
    Effect.catchAll((error) =>
      Effect.succeed<RobotsTxtData>({
        exists: false,
        url: robotsUrl,
        content: null,
        sizeBytes: 0,
        sitemaps: [],
        rules: [],
        errors: [error.message],
      })
    )
  );
}

/**
 * Fetch robots.txt and update context
 */
export function fetchRobotsTxtAndUpdateContext(
  contextRef: ContextRef
): Effect.Effect<RobotsTxtData, never, never> {
  return Effect.gen(function* () {
    const ctx = yield* getContext(contextRef);
    const robotsTxt = yield* fetchRobotsTxt(
      ctx.baseUrl,
      ctx.settings.crawler.userAgent
    );
    yield* updateContext(contextRef, (c) => setRobotsTxt(c, robotsTxt));
    return robotsTxt;
  });
}
