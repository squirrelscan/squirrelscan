import { Effect } from "effect";
import robotsParser from "robots-parser";

import type { RobotsTxtData } from "@squirrelscan/core-contracts";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";
import { readBodyCapped } from "@squirrelscan/utils/response-body";

import { BUDGET_EXHAUSTED_ERROR, budgetedTimeoutMs, safeFetchWithDeadline } from "./deadline";

import type { PhaseBudget } from "./deadline";

// Matches the limit Google documents for robots.txt; anything past it is
// ignored by real crawlers, so there is nothing to gain by reading further.
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_FETCH_TIMEOUT_MS = 30_000;

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

function unreachableEvaluator(robotsUrl: string, error: string): RobotsEvaluator {
  return { data: emptyRobotsData(robotsUrl, error), isAllowed: () => true, crawlDelayMs: null };
}

export function fetchRobotsEvaluator(
  baseUrl: string,
  userAgent: string,
  respectRobots: boolean,
  customHeaders?: Record<string, string>,
  budget?: PhaseBudget,
): Effect.Effect<RobotsEvaluator, never, never> {
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();

  if (!respectRobots) {
    return Effect.succeed(createRobotsEvaluator(robotsUrl, null, userAgent));
  }

  const timeoutMs = budgetedTimeoutMs(budget, ROBOTS_FETCH_TIMEOUT_MS);
  if (timeoutMs === null) {
    return Effect.succeed(unreachableEvaluator(robotsUrl, BUDGET_EXHAUSTED_ERROR));
  }

  return Effect.tryPromise({
    try: () =>
      safeFetchWithDeadline(
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
        timeoutMs,
        async (response) => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return createRobotsEvaluator(robotsUrl, null, userAgent);
          }

          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return unreachableEvaluator(robotsUrl, `HTTP ${response.status}`);
          }

          // Bounded: robots.txt is fetched before anything else is known about the
          // host, so an unbounded read here is reachable on the very first request
          // of an audit.
          const content = await readBodyCapped(response, ROBOTS_MAX_BYTES);
          return createRobotsEvaluator(robotsUrl, content, userAgent);
        },
      ),
    catch: (error) => unreachableEvaluator(robotsUrl, (error as Error).message),
  }).pipe(Effect.catchAll((err) => Effect.succeed(err)));
}
