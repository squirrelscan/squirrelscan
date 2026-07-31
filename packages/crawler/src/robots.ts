import { Effect } from "effect";
import robotsParser from "robots-parser";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";
import { readBodyCapped } from "@squirrelscan/utils/response-body";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";

// Matches the limit Google documents for robots.txt; anything past it is
// ignored by real crawlers, so there is nothing to gain by reading further.
const ROBOTS_MAX_BYTES = 512 * 1024;

export interface RobotsEvaluator {
  data: RobotsTxtData;
  isAllowed: (url: string) => boolean;
  crawlDelayMs: number | null;
}

function emptyRobotsData(url: string, error?: string): RobotsTxtData {
  return {
    exists: false,
    url,
    content: null,
    sizeBytes: 0,
    sitemaps: [],
    rules: [],
    errors: error ? [error] : [],
  };
}

export function createRobotsEvaluator(
  robotsUrl: string,
  content: string | null,
  userAgent: string,
): RobotsEvaluator {
  const parser = robotsParser(robotsUrl, content ?? "");
  const sitemaps = parser.getSitemaps?.() ?? [];
  const crawlDelay = parser.getCrawlDelay?.(userAgent);

  const data: RobotsTxtData =
    content !== null
      ? {
          ...parseRobotsTxt(content, robotsUrl),
          sitemaps: sitemaps.length > 0 ? sitemaps : [],
        }
      : {
          exists: false,
          url: robotsUrl,
          content: null,
          sizeBytes: 0,
          sitemaps: [],
          rules: [],
          errors: [],
        };

  return {
    data,
    isAllowed: (url: string) => parser.isAllowed(url, userAgent) ?? true,
    crawlDelayMs:
      typeof crawlDelay === "number" && Number.isFinite(crawlDelay)
        ? Math.max(0, Math.round(crawlDelay * 1000))
        : null,
  };
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // #1395: follow redirects manually so per-hop the scheme allowlist applies and
  // the caller's secret customHeaders are stripped when a redirect changes origin
  // (native redirect:"follow" would replay them cross-origin).
  return safeRedirectFetch(url, {
    ...options,
    signal: controller.signal,
  })
    .then((result) => result.response)
    .finally(() => clearTimeout(timeout));
}

export function fetchRobotsEvaluator(
  baseUrl: string,
  userAgent: string,
  respectRobots: boolean,
  customHeaders?: Record<string, string>,
): Effect.Effect<RobotsEvaluator, never, never> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();

  if (!respectRobots) {
    return Effect.succeed(createRobotsEvaluator(robotsUrl, null, userAgent));
  }

  return Effect.tryPromise({
    try: async () => {
      const response = await fetchWithTimeout(
        robotsUrl,
        {
          headers: {
            "User-Agent": userAgent,
            Accept: "text/plain",
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1",
            ...customHeaders,
          },
        },
        30_000,
      );

      if (response.status === 404) {
        return createRobotsEvaluator(robotsUrl, null, userAgent);
      }

      if (!response.ok) {
        const data = emptyRobotsData(robotsUrl, `HTTP ${response.status}`);
        return {
          data,
          isAllowed: () => true,
          crawlDelayMs: null,
        };
      }

      // Bounded: robots.txt is fetched before anything else is known about the
      // host, so an unbounded read here is reachable on the very first request
      // of an audit.
      const content = await readBodyCapped(response, ROBOTS_MAX_BYTES);
      return createRobotsEvaluator(robotsUrl, content, userAgent);
    },
    catch: (error) => {
      const data = emptyRobotsData(robotsUrl, (error as Error).message);
      return {
        data,
        isAllowed: () => true,
        crawlDelayMs: null,
      };
    },
  }).pipe(Effect.catchAll((err) => Effect.succeed(err)));
}
