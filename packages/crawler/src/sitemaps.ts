import { Effect, pipe } from "effect";
import { XMLParser } from "fast-xml-parser";

import type {
  RobotsTxtData,
  SitemapData,
  SitemapFetchFailure,
  SitemapUrl,
} from "@squirrelscan/core-contracts";

const logger = {
  debug: (_message: string, ..._args: unknown[]) => {},
};

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
        url?:
          | {
              loc?: string;
              lastmod?: string;
              changefreq?: string;
              priority?: string | number;
            }
          | {
              loc?: string;
              lastmod?: string;
              changefreq?: string;
              priority?: string | number;
            }[];
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
          priority: Number.isNaN(priority ?? Number.NaN) ? undefined : priority,
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
  } catch (error) {
    return {
      url,
      type: "urlset",
      urls: [],
      childSitemaps: [],
      errors: [`Parse error: ${(error as Error).message}`],
      urlCount: 0,
    };
  }
}

export type SitemapFetchResult =
  | { success: true; data: SitemapData }
  | { success: false; url: string; error: string };

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

export function fetchSitemap(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
): Effect.Effect<SitemapFetchResult, never, never> {
  return pipe(
    Effect.tryPromise({
      try: () =>
        fetchWithTimeout(
          url,
          {
            headers: {
              "User-Agent": userAgent,
              Accept: "application/xml, text/xml, */*",
              "Accept-Language": "en-US,en;q=0.9",
              ...customHeaders,
            },
            redirect: "follow",
          },
          30_000,
        ),
      catch: (error) => ({
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : "Network error",
      }),
    }),
    Effect.flatMap((response) => {
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

          return {
            success: true,
            data: parseSitemap(content, url),
          };
        }),
      );
    }),
    Effect.catchAll(() =>
      Effect.succeed({
        success: false,
        url,
        error: "Unexpected error",
      } as SitemapFetchResult),
    ),
  );
}

const SITEMAP_FETCH_CONCURRENCY = 5;

/**
 * Mutable URL budget shared across the recursive sitemap fetch.
 * Once `remaining` drops to 0 no further sitemaps (including
 * sitemap-index children) are fetched. Prevents huge sites
 * (news sites with 400k+ sitemap URLs across thousands of child
 * sitemaps) from being ingested wholesale when we only crawl maxPages.
 */
export interface SitemapUrlBudget {
  remaining: number;
}

/**
 * Compute the sitemap URL ingestion cap for a crawl budget.
 * We keep ~10x the page budget so coverage modes still have a diverse
 * pool to prioritize from, with a floor of 1000.
 */
export function computeSitemapUrlCap(maxPages: number): number {
  return Math.max(maxPages * 10, 1000);
}

export function fetchSitemapsRecursive(
  urls: string[],
  userAgent: string,
  maxDepth = 3,
  currentDepth = 0,
  seen: Set<string> = new Set(),
  urlBudget?: SitemapUrlBudget,
  customHeaders?: Record<string, string>,
): Effect.Effect<SitemapFetchResult[], never, never> {
  if (currentDepth >= maxDepth || urls.length === 0) {
    return Effect.succeed([]);
  }
  if (urlBudget && urlBudget.remaining <= 0) {
    return Effect.succeed([]);
  }

  return Effect.gen(function* () {
    const unseenUrls = urls.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    if (unseenUrls.length === 0) {
      return [];
    }

    const fetchResults: SitemapFetchResult[] = [];
    const childUrls: string[] = [];

    // Fetch in chunks so we can stop early once the URL budget is exhausted
    // instead of fetching every child of a huge sitemap index.
    for (let i = 0; i < unseenUrls.length; i += SITEMAP_FETCH_CONCURRENCY) {
      if (urlBudget && urlBudget.remaining <= 0) {
        logger.debug(
          "sitemap URL budget exhausted, skipping remaining sitemaps",
          `${unseenUrls.length - i} skipped at depth ${currentDepth}`,
        );
        break;
      }

      const chunk = unseenUrls.slice(i, i + SITEMAP_FETCH_CONCURRENCY);
      const chunkResults = yield* Effect.all(
        chunk.map((url) => fetchSitemap(url, userAgent, customHeaders)),
        { concurrency: SITEMAP_FETCH_CONCURRENCY },
      );
      fetchResults.push(...chunkResults);

      for (const result of chunkResults) {
        if (!result.success) continue;
        const sitemap = result.data;

        if (urlBudget) {
          urlBudget.remaining -= sitemap.urlCount;
        }

        if (sitemap.type !== "index") continue;

        const parentHost = new URL(sitemap.url).host;
        for (const childUrl of sitemap.childSitemaps) {
          try {
            const childHost = new URL(childUrl).host;
            if (childHost !== parentHost) {
              logger.debug(
                "cross-domain sitemap reference skipped",
                `${sitemap.url} -> ${childUrl}`,
              );
              continue;
            }
            childUrls.push(childUrl);
          } catch {
            logger.debug("invalid child sitemap URL", childUrl);
          }
        }
      }
    }

    const childResults = yield* fetchSitemapsRecursive(
      childUrls,
      userAgent,
      maxDepth,
      currentDepth + 1,
      seen,
      urlBudget,
      customHeaders,
    );

    return [...fetchResults, ...childResults];
  });
}

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
  discovered: SitemapData[];
  all: SitemapData[];
  failed: SitemapFetchFailure[];
}

export interface DiscoverSitemapsOptions {
  /** Stop fetching further sitemaps once this many URLs have been parsed */
  maxUrls?: number;
  /** Custom HTTP headers attached to every sitemap fetch (e.g. Web Bot Auth signatures). */
  customHeaders?: Record<string, string>;
}

export function discoverSitemaps(
  baseUrl: string,
  robotsTxt: RobotsTxtData | null,
  userAgent: string,
  options: DiscoverSitemapsOptions = {},
): Effect.Effect<SitemapDiscoveryResult, never, never> {
  return Effect.gen(function* () {
    const sitemapUrls = new Set<string>();
    const robotsSitemaps = new Set<string>();

    if (robotsTxt?.sitemaps) {
      for (const sitemap of robotsTxt.sitemaps) {
        try {
          const resolvedUrl = new URL(sitemap, baseUrl).toString();
          sitemapUrls.add(resolvedUrl);
          robotsSitemaps.add(resolvedUrl);
        } catch {
          logger.debug(`Invalid sitemap URL in robots.txt: ${sitemap}`);
        }
      }
    }

    for (const path of COMMON_SITEMAP_LOCATIONS) {
      sitemapUrls.add(new URL(path, baseUrl).toString());
    }

    const entryPoints = Array.from(sitemapUrls);
    const urlBudget: SitemapUrlBudget | undefined =
      options.maxUrls !== undefined ? { remaining: options.maxUrls } : undefined;
    const allResults = yield* fetchSitemapsRecursive(
      entryPoints,
      userAgent,
      undefined,
      undefined,
      undefined,
      urlBudget,
      options.customHeaders,
    );

    const allSitemaps = allResults.filter((result) => result.success).map((result) => result.data);
    const entryPointSet = new Set(entryPoints);
    const discovered = allSitemaps.filter((sitemap) => entryPointSet.has(sitemap.url));

    const failed: SitemapFetchFailure[] = allResults
      .filter(
        (result): result is { success: false; url: string; error: string } =>
          !result.success && entryPointSet.has(result.url),
      )
      .map((result) => ({
        url: result.url,
        source: robotsSitemaps.has(result.url) ? ("robots.txt" as const) : ("common" as const),
        error: result.error,
      }));

    return { discovered, all: allSitemaps, failed };
  });
}

/**
 * Select up to `cap` URLs for enqueueing, round-robin across sitemaps so
 * coverage modes sample every section (child sitemaps usually map to
 * sections/post types/date archives) instead of exhausting the first
 * sitemap file before the cap is hit. Deduplicates by loc.
 */
export function selectSitemapUrls(sitemaps: SitemapData[], cap: number): SitemapUrl[] {
  const lists = sitemaps.filter((sitemap) => sitemap.urls.length > 0).map((sitemap) => sitemap.urls);
  const selected: SitemapUrl[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let anyLeft = true;

  while (anyLeft && selected.length < cap) {
    anyLeft = false;
    for (const urls of lists) {
      if (selected.length >= cap) break;
      const url = urls[offset];
      if (!url) continue;
      anyLeft = true;
      if (seen.has(url.loc)) continue;
      seen.add(url.loc);
      selected.push(url);
    }
    offset++;
  }

  return selected;
}

export function getUrlsFromSitemaps(sitemaps: SitemapData[]): string[] {
  const urls: string[] = [];
  for (const sitemap of sitemaps) {
    for (const url of sitemap.urls) {
      urls.push(url.loc);
    }
  }
  return urls;
}
