// External link checker
// Uses HEAD requests with GET fallback, optional cache, WAF detection

import { Effect } from "effect";

import { detectWaf, type WafProvider } from "@squirrelscan/waf-detect";

// ============================================
// LINK CACHE INTERFACE (implemented by CLI's LinkCacheStorage)
// ============================================

export interface LinkCacheEntry {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  checkedAt: number;
  wafBlocked?: boolean;
  wafProvider?: string;
}

/** Injectable link cache — CLI provides SQLite-backed cache; cloud passes null (no caching). */
export interface LinkCache {
  getCachedBulk(urls: string[], ttlSeconds: number): Map<string, LinkCacheEntry>;
  setCachedBulk(entries: LinkCacheEntry[]): void;
}

// ============================================
// TYPES
// ============================================

export interface ExternalCheckResult {
  href: string;
  status: number | null;
  error: string | null;
  redirectTarget: string | null;
  fromCache: boolean;
  wafBlocked?: boolean;
  wafProvider?: WafProvider;
}

export interface ExternalCheckerOptions {
  ttlSeconds: number;
  concurrency: number;
  timeoutMs: number;
  userAgent: string;
  /**
   * Optional cloud bulk checker (e.g. the credit-gated /v1/services/dead-links
   * endpoint). When present it is tried FIRST for every url the local cache
   * misses; urls it resolves skip the per-link local fetch. Any throw falls
   * back to the existing per-link local path for the remaining urls. The map
   * is keyed by the exact requested url.
   */
  bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
}

/** Max urls per bulk-checker call — mirrors SERVICE_LIMITS.deadLinksBatchUrls. */
export const BULK_CHECK_CHUNK_SIZE = 200;

/**
 * Run a bulk checker over `urls` in chunks, accumulating whatever it resolves.
 * Never throws: a failing chunk stops the bulk pass and the unresolved
 * remainder takes the per-link local path.
 */
export async function runBulkChecker(
  bulkChecker: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>,
  urls: string[],
  chunkSize: number = BULK_CHECK_CHUNK_SIZE
): Promise<Map<string, ExternalCheckResult>> {
  const resolved = new Map<string, ExternalCheckResult>();
  for (let i = 0; i < urls.length; i += chunkSize) {
    try {
      const chunk = await bulkChecker(urls.slice(i, i + chunkSize));
      for (const [url, result] of chunk) resolved.set(url, result);
    } catch {
      break; // cloud unavailable — remaining urls fall back to local checks
    }
  }
  return resolved;
}

const DEFAULT_OPTIONS: ExternalCheckerOptions = {
  ttlSeconds: 7 * 24 * 60 * 60,
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

async function checkSingleUrlAsync(
  href: string,
  options: ExternalCheckerOptions
): Promise<CheckUrlResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    try {
      const headResponse = await fetch(href, {
        method: "HEAD",
        headers: { "User-Agent": options.userAgent, Accept: "*/*" },
        signal: controller.signal,
        redirect: "follow",
      });

      if (headResponse.status < 400) {
        clearTimeout(timeoutId);
        return {
          status: headResponse.status,
          error: null,
          redirectTarget: headResponse.url !== href ? headResponse.url : null,
        };
      }
    } catch {
      // HEAD failed, try GET
    }

    const getResponse = await fetch(href, {
      method: "GET",
      headers: { "User-Agent": options.userAgent, Accept: "*/*" },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);
    const redirectTarget = getResponse.url !== href ? getResponse.url : null;

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
        // Ignore body read errors
      }
    }

    return { status: getResponse.status, error: null, redirectTarget };
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error).name === "AbortError") {
      return { status: null, error: "timeout", redirectTarget: null };
    }
    return { status: null, error: (error as Error).message || "Unknown error", redirectTarget: null };
  }
}

function checkSingleUrl(
  href: string,
  options: ExternalCheckerOptions
): Effect.Effect<CheckUrlResult, never, never> {
  return Effect.promise(() => checkSingleUrlAsync(href, options));
}

export function checkExternalLinks(
  urls: string[],
  cache: LinkCache | null,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult[], never, never> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, opts.concurrency);

  return Effect.gen(function* () {
    if (urls.length === 0) return [];

    const uniqueUrls = [...new Set(urls)];
    const results: ExternalCheckResult[] = [];
    let urlsToCheck: string[] = [];

    if (cache) {
      const cachedEntries = cache.getCachedBulk(uniqueUrls, opts.ttlSeconds);
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
    } else {
      urlsToCheck.push(...uniqueUrls);
    }

    if (urlsToCheck.length === 0) return results;

    // Cloud bulk path: resolve local-cache misses via the bulk checker first.
    // Resolved urls are surfaced as-is and written into the local cache so the
    // next run is a pure local hit; the unresolved remainder (or everything,
    // if the bulk checker failed) takes the per-link local path below.
    if (opts.bulkChecker) {
      const bulkResolved = yield* Effect.promise(() =>
        runBulkChecker(opts.bulkChecker!, urlsToCheck)
      );
      if (bulkResolved.size > 0) {
        const stillToCheck: string[] = [];
        const bulkCacheEntries: LinkCacheEntry[] = [];
        for (const url of urlsToCheck) {
          const resolved = bulkResolved.get(url);
          if (resolved) {
            results.push({ ...resolved, href: url });
            bulkCacheEntries.push({
              href: url,
              status: resolved.status,
              error: resolved.error,
              redirectTarget: resolved.redirectTarget,
              checkedAt: Date.now(),
              wafBlocked: resolved.wafBlocked,
              wafProvider: resolved.wafProvider,
            });
          } else {
            stillToCheck.push(url);
          }
        }
        if (cache && bulkCacheEntries.length > 0) {
          cache.setCachedBulk(bulkCacheEntries);
        }
        urlsToCheck = stillToCheck;
      }
    }

    if (urlsToCheck.length === 0) return results;

    const checkEffects = urlsToCheck.map((href) =>
      checkSingleUrl(href, opts).pipe(
        Effect.map((result) => ({ href, ...result }))
      )
    );

    const checkedResults = yield* Effect.all(checkEffects, {
      concurrency: opts.concurrency,
    });

    if (cache) {
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
    }

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

export function checkExternalLink(
  href: string,
  cache: LinkCache | null,
  options?: Partial<ExternalCheckerOptions>
): Effect.Effect<ExternalCheckResult, never, never> {
  return checkExternalLinks([href], cache, options).pipe(
    Effect.map((results) => results[0]!)
  );
}

export function filterBrokenLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => {
    if (r.error) return true;
    if (r.status === 403 && r.wafBlocked) return false;
    if (r.status && r.status >= 400) return true;
    return false;
  });
}

export function filterWafBlockedLinks(
  results: ExternalCheckResult[]
): ExternalCheckResult[] {
  return results.filter((r) => r.wafBlocked === true);
}

export function getDisplayStatus(result: ExternalCheckResult): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.status === null) return "Unknown";
  return String(result.status);
}
