// Discover sitemaps processor
// Discovers and parses sitemaps from robots.txt and common locations

import { Effect, pipe } from "effect";
import { XMLParser } from "fast-xml-parser";

import type { ContextRef } from "@/infra/context";
import type {
  SitemapData,
  SitemapUrl,
  RobotsTxtData,
  SitemapFetchFailure,
} from "@/types";

import {
  getContext,
  updateContext,
  addSitemap,
  addToQueue,
} from "@/infra/context";
import { logger } from "@/utils/logger";

// ============================================
// SITEMAP PARSING
// ============================================

/**
 * Parse sitemap XML content
 */
export function parseSitemap(content: string, url: string): SitemapData {
  const errors: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    processEntities: false,
  });

  const ensureArray = <T>(value: T | T[] | undefined): T[] => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  };

  try {
    const parsed = parser.parse(content) as Record<string, unknown>;

    if (parsed.sitemapindex) {
      const sitemapIndex = parsed.sitemapindex as {
        sitemap?: { loc?: string } | { loc?: string }[];
      };
      const sitemapEntries = ensureArray(sitemapIndex.sitemap);
      const childSitemaps = sitemapEntries
        .map((entry) => entry.loc?.trim())
        .filter((loc): loc is string => Boolean(loc));

      return {
        url,
        type: "index",
        urls: [],
        childSitemaps,
        errors,
        urlCount: 0,
      };
    }

    if (parsed.urlset) {
      const urlset = parsed.urlset as {
        url?: {
          loc?: string;
          lastmod?: string;
          changefreq?: string;
          priority?: string | number;
        };
      };
      const urlEntries = ensureArray(urlset.url);
      const urls: SitemapUrl[] = [];

      for (const entry of urlEntries) {
        const loc = entry.loc?.trim();
        if (!loc) continue;

        const priorityRaw = entry.priority;
        const priority =
          typeof priorityRaw === "number"
            ? priorityRaw
            : priorityRaw
              ? Number.parseFloat(priorityRaw)
              : undefined;

        urls.push({
          loc,
          lastmod: entry.lastmod?.trim(),
          changefreq: entry.changefreq?.trim(),
          priority: Number.isNaN(priority ?? NaN) ? undefined : priority,
        });
      }

      return {
        url,
        type: "urlset",
        urls,
        childSitemaps: [],
        errors,
        urlCount: urls.length,
      };
    }

    return {
      url,
      type: "urlset",
      urls: [],
      childSitemaps: [],
      errors: ["Unknown sitemap format"],
      urlCount: 0,
    };
  } catch (e) {
    return {
      url,
      type: "urlset",
      urls: [],
      childSitemaps: [],
      errors: [`Parse error: ${(e as Error).message}`],
      urlCount: 0,
    };
  }
}

// ============================================
// FETCH SITEMAP
// ============================================

/**
 * Fetch result - discriminated union for success/failure tracking
 */
export type SitemapFetchResult =
  | { success: true; data: SitemapData }
  | { success: false; url: string; error: string };

/**
 * Fetch a single sitemap
 * Uses standard fetch (not IMPIT) since sitemaps are meant to be crawled by bots
 * Returns success/failure result to enable tracking of failed fetches
 */
export function fetchSitemap(
  url: string,
  userAgent: string
): Effect.Effect<SitemapFetchResult, never, never> {
  return pipe(
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        try {
          const response = await fetch(url, {
            headers: {
              "User-Agent": userAgent,
              Accept: "application/xml, text/xml, */*",
              "Accept-Language": "en-US,en;q=0.9",
            },
            signal: controller.signal,
            redirect: "follow",
          });
          return response;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      catch: (error) => ({
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : "Network error",
      }),
    }),
    Effect.flatMap((response) => {
      // Network error or non-2xx status
      if (!response.ok) {
        const errorMsg =
          "status" in response && response.status
            ? `HTTP ${response.status}`
            : "error" in response
              ? String(response.error)
              : "Network error";
        return Effect.succeed<SitemapFetchResult>({
          success: false,
          url,
          error: errorMsg,
        });
      }

      return Effect.tryPromise({
        try: () => response.text(),
        catch: () => null,
      }).pipe(
        Effect.map((content): SitemapFetchResult => {
          if (!content) {
            return {
              success: false,
              url,
              error: "Empty response",
            };
          }
          const parsed = parseSitemap(content, url);
          return {
            success: true,
            data: parsed,
          } as SitemapFetchResult;
        })
      );
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        success: false,
        url,
        error: "Unexpected error",
      } as SitemapFetchResult)
    )
  );
}

const SITEMAP_FETCH_CONCURRENCY = 5;

/**
 * Recursively fetch sitemaps (including child sitemaps from index)
 * Deduplicates by URL to avoid fetching the same sitemap twice
 * Fetches in parallel with concurrency limit for performance
 * Returns both successful and failed results
 */
export function fetchSitemapsRecursive(
  urls: string[],
  userAgent: string,
  maxDepth: number = 3,
  currentDepth: number = 0,
  seen: Set<string> = new Set()
): Effect.Effect<SitemapFetchResult[], never, never> {
  if (currentDepth >= maxDepth || urls.length === 0) {
    return Effect.succeed([]);
  }

  return Effect.gen(function* () {
    // Filter to unseen URLs and mark as seen
    const unseenUrls = urls.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    if (unseenUrls.length === 0) {
      return [];
    }

    // Fetch all sitemaps in parallel with concurrency limit
    const fetchResults = yield* Effect.all(
      unseenUrls.map((url) => fetchSitemap(url, userAgent)),
      { concurrency: SITEMAP_FETCH_CONCURRENCY }
    );

    // Use type guard to properly narrow successful results
    const sitemaps = fetchResults
      .filter((r): r is { success: true; data: SitemapData } => r.success)
      .map((r) => r.data);

    // Collect child sitemaps from indices, filtering cross-domain references
    const childUrls: string[] = [];
    for (const sitemap of sitemaps) {
      if (sitemap.type !== "index") continue;

      const parentHost = new URL(sitemap.url).host;
      for (const childUrl of sitemap.childSitemaps) {
        try {
          const childHost = new URL(childUrl).host;
          if (childHost !== parentHost) {
            logger.debug(
              "cross-domain sitemap reference skipped",
              `${sitemap.url} -> ${childUrl}`
            );
            continue;
          }
          childUrls.push(childUrl);
        } catch {
          logger.debug("invalid child sitemap URL", childUrl);
        }
      }
    }

    // Recursively fetch children
    const childResults = yield* fetchSitemapsRecursive(
      childUrls,
      userAgent,
      maxDepth,
      currentDepth + 1,
      seen
    );

    return [...fetchResults, ...childResults];
  });
}

// ============================================
// DISCOVER SITEMAPS
// ============================================

const COMMON_SITEMAP_LOCATIONS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemaps.xml",
  "/sitemap1.xml",
  "/post-sitemap.xml",
  "/page-sitemap.xml",
  "/news-sitemap.xml",
];

export interface SitemapDiscoveryResult {
  /** Top-level sitemaps found at entry points (robots.txt + common locations) */
  discovered: SitemapData[];
  /** All sitemaps including children of sitemap indices */
  all: SitemapData[];
  /** Sitemaps that failed to fetch */
  failed: SitemapFetchFailure[];
}

/**
 * Discover sitemaps from robots.txt and common locations
 * Returns both discovered (top-level) and all sitemaps (including children)
 */
export function discoverSitemaps(
  baseUrl: string,
  robotsTxt: RobotsTxtData | null,
  userAgent: string
): Effect.Effect<SitemapDiscoveryResult, never, never> {
  return Effect.gen(function* () {
    const sitemapUrls = new Set<string>();
    const robotsSitemaps = new Set<string>();

    // Add sitemaps from robots.txt (resolve relative URLs)
    if (robotsTxt?.sitemaps) {
      for (const sitemap of robotsTxt.sitemaps) {
        try {
          const resolvedUrl = new URL(sitemap, baseUrl).toString();
          sitemapUrls.add(resolvedUrl);
          robotsSitemaps.add(resolvedUrl);
        } catch {
          // Invalid URL - will be tracked as failed
          logger.debug(`Invalid sitemap URL in robots.txt: ${sitemap}`);
        }
      }
    }

    // Add common locations
    for (const path of COMMON_SITEMAP_LOCATIONS) {
      sitemapUrls.add(new URL(path, baseUrl).toString());
    }

    const entryPoints = Array.from(sitemapUrls);

    // Fetch all sitemaps (including children)
    const allResults = yield* fetchSitemapsRecursive(entryPoints, userAgent);

    // Separate successful and failed results
    const allSitemaps = allResults.filter((r) => r.success).map((r) => r.data);
    const entryPointSet = new Set(entryPoints);
    const discovered = allSitemaps.filter((s) => entryPointSet.has(s.url));

    // Collect failures for entry points only (not child sitemaps)
    const failed: SitemapFetchFailure[] = allResults
      .filter(
        (r): r is { success: false; url: string; error: string } =>
          !r.success && entryPointSet.has(r.url)
      )
      .map((r) => ({
        url: r.url,
        source: robotsSitemaps.has(r.url)
          ? ("robots.txt" as const)
          : ("common" as const),
        error: r.error,
      }));

    return { discovered, all: allSitemaps, failed };
  });
}

/**
 * Discover sitemaps and update context
 */
export function discoverSitemapsAndUpdateContext(
  contextRef: ContextRef
): Effect.Effect<SitemapData[], never, never> {
  return Effect.gen(function* () {
    const ctx = yield* getContext(contextRef);

    const result = yield* discoverSitemaps(
      ctx.baseUrl,
      ctx.project.site.robotsTxt,
      ctx.settings.crawler.userAgent
    );

    // Update context with discovered sitemaps only
    let currentCtx = ctx;
    for (const sitemap of result.discovered) {
      currentCtx = addSitemap(currentCtx, sitemap);
    }

    // Store failed sitemaps
    currentCtx = {
      ...currentCtx,
      project: {
        ...currentCtx.project,
        site: {
          ...currentCtx.project.site,
          failedSitemaps: result.failed,
        },
      },
    };

    // Add sitemap URLs from ALL sitemaps to crawl queue
    const urlsFromSitemaps = result.all.flatMap((s) =>
      s.urls.map((u) => u.loc)
    );
    currentCtx = addToQueue(currentCtx, urlsFromSitemaps);

    yield* updateContext(contextRef, () => currentCtx);

    return result.discovered;
  });
}

/**
 * Get all URLs from discovered sitemaps
 */
export function getUrlsFromSitemaps(sitemaps: SitemapData[]): string[] {
  const urls: string[] = [];
  for (const sitemap of sitemaps) {
    for (const url of sitemap.urls) {
      urls.push(url.loc);
    }
  }
  return urls;
}
