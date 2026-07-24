// External link checker with caching
// Uses HEAD requests with GET fallback, caches results globally
// Detects WAF-blocked 403s to avoid false positive broken links

import { Effect } from "effect";

import { detectWaf, type WafProvider } from "@/utils/waf";

import type { LinkCacheEntry, LinkCacheStorage } from "./storage/link-cache";

export interface ExternalCheckResult {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  fromCache: boolean;
  /** True if 403 appears to be WAF/bot protection rather than real forbidden */
  wafBlocked?: boolean;
  /** Detected WAF provider if wafBlocked is true */
  wafProvider?: WafProvider;
}

export interface ExternalCheckerOptions {
  ttlSeconds: number;
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
}

const DEFAULT_OPTIONS: ExternalCheckerOptions = {
  ttlSeconds: 7 * 24 * 60 * 60, // 7 days
  concurrency: 5,
  timeoutMs: 10000,
  userAgent: "SquirrelScan/2.0 (+https://squirrelscan.com)",
};

interface CheckUrlResult {
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  wafBlocked?: boolean;
  wafProvider?: WafProvider;
}

/**
 * Check a single external URL using HEAD, fallback to GET
 * Falls back to GET for:
 * - 405 Method Not Allowed
 * - Any 4xx/5xx response (servers often block HEAD but allow GET)
 * - Network errors
 */
async function checkSingleUrlAsync(
  href: string,
  options: ExternalCheckerOptions
): Promise<CheckUrlResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    // Try HEAD first (faster, less bandwidth)
    try {
      const headResponse = await fetch(href, {
        method: "HEAD",
        headers: {
          "User-Agent": options.userAgent,
          Accept: "*/*",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      // Only trust HEAD for success (2xx/3xx)
      // Many servers return 401/403/429 to HEAD but allow GET
      if (headResponse.status < 400) {
        clearTimeout(timeoutId);
        const redirectTarget =
          headResponse.url !== href ? headResponse.url : null;
        return {
          status: headResponse.status,
          error: null,
          redirectTarget,
        };
      }
      // HEAD returned 4xx/5xx, fall through to GET to verify
    } catch {
      // HEAD failed (network error), try GET below
    }

    // HEAD failed, returned 4xx/5xx, or returned 405 - verify with GET
    const getResponse = await fetch(href, {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent,
        Accept: "*/*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);
    const redirectTarget = getResponse.url !== href ? getResponse.url : null;

    // For 403 responses, check if it's WAF/bot protection
    if (getResponse.status === 403) {
      try {
        const body = await getResponse.text();
        const wafResult = detectWaf(getResponse.headers, body);
        if (wafResult.detected) {
          return {
            status: 403,
            error: null,
            redirectTarget,
            wafBlocked: true,
            wafProvider: wafResult.provider ?? "unknown",
          };
        }
      } catch {
        // Ignore body read errors, treat as regular 403
      }
    }

    return {
      status: getResponse.status,
      error: null,
      redirectTarget,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if ((error as Error).name === "AbortError") {
      return {
        status: null,
        error: "timeout",
        redirectTarget: null,
      };
    }

    return {
      status: null,
      error: (error as Error).message || "Unknown error",
      redirectTarget: null,
    };
  }
}

function checkSingleUrl(
  href: string,
  options: ExternalCheckerOptions
): Effect.Effect<CheckUrlResult, never, never> {
  return Effect.promise(() => checkSingleUrlAsync(href, options));
}

/**
 * Check multiple external URLs with caching
 * Returns results for all URLs, using cache when available
 */
export function checkExternalLinks(
  urls: string[],
  cache: LinkCacheStorage,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // Safety clamp: ensure concurrency is at least 1 to prevent infinite loops
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    // Deduplicate URLs
    const uniqueUrls = [...new Set(urls)];

    // Check cache for all URLs
    const cachedEntries = cache.getCachedBulk(uniqueUrls, opts.ttlSeconds);
    const results: ExternalCheckResult[] = [];
    const urlsToCheck: string[] = [];

    for (const url of uniqueUrls) {
      const cached = cachedEntries.get(url);
      if (cached) {
        results.push({
          href: cached.href,
          status: cached.status,
          error: cached.error,
          redirectTarget: cached.redirectTarget,
          fromCache: true,
          wafBlocked: cached.wafBlocked,
          wafProvider: cached.wafProvider as WafProvider | undefined,
        });
      } else {
        urlsToCheck.push(url);
      }
    }

    // If nothing to check, return cached results
    if (urlsToCheck.length === 0) {
      return results;
    }

    // Check remaining URLs with sliding-window concurrency
    const checkEffects = urlsToCheck.map((href) =>
      checkSingleUrl(href, opts).pipe(
        Effect.map((result) => ({
          href,
          ...result,
        }))
      )
    );

    const checkedResults = yield* Effect.all(checkEffects, {
      concurrency: opts.concurrency,
    });

    // Cache the new results
    const cacheEntries: LinkCacheEntry[] = checkedResults.map((r) => ({
      href: r.href,
      status: r.status,
      error: r.error,
      redirectTarget: r.redirectTarget,
      checkedAt: Date.now(),
      wafBlocked: r.wafBlocked,
      wafProvider: r.wafProvider,
    }));
    cache.setCachedBulk(cacheEntries);

    // Add checked results to final results
    for (const r of checkedResults) {
      results.push({
        href: r.href,
        status: r.status,
        error: r.error,
        redirectTarget: r.redirectTarget,
        fromCache: false,
        wafBlocked: r.wafBlocked,
        wafProvider: r.wafProvider,
      });
    }

    return results;
  });
}

/**
 * Check a single URL (convenience wrapper)
 */
export function checkExternalLink(
  href: string,
  cache: LinkCacheStorage,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult, never, never> {
  return checkExternalLinks([href], cache, options).pipe(
    Effect.map((results) => results[0]!)
  );
}

/**
 * Filter results to only broken links (4xx/5xx or errors)
 * Excludes WAF-blocked 403s since those are not truly broken
 */
export function filterBrokenLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => {
    if (r.error) return true;
    // WAF-blocked 403s are not truly broken - they're just inaccessible to bots
    if (r.status === 403 && r.wafBlocked) return false;
    if (r.status && r.status >= 400) return true;
    return false;
  });
}

/**
 * Filter results to only WAF-blocked links
 */
export function filterWafBlockedLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => r.wafBlocked === true);
}

/**
 * Get display status for a check result
 */
export function getDisplayStatus(result: ExternalCheckResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.status === null) return "Unknown";
  return String(result.status);
}
