import { Effect } from "effect";
import { XMLParser } from "fast-xml-parser";

import type {
  RobotsTxtData,
  SitemapData,
  SitemapFetchFailure,
  SitemapUrl,
} from "@squirrelscan/core-contracts";
import { isHttpOrHttpsUrl } from "@squirrelscan/utils/safe-fetch";

import { safeFetchWithDeadline } from "./deadline";

/** Recorded against a sitemap the walk gave up on before reaching it. */
export const SITEMAP_NOT_REACHED_ERROR = "sitemap walk stopped before reaching this location";

const logger = {
  debug: (_message: string, ..._args: unknown[]) => {},
};

/**
 * Decode the five XML predefined escapes.
 *
 * The parser runs with `processEntities: false` to block declared-entity
 * substitution (billion-laughs / XXE, pinned by sitemap-entity-expansion.test.ts).
 * That flag also suppresses the predefined five, which are not declarations and
 * are the spec-mandated way to encode `&` in a sitemap URL — without this a
 * `?q=1&amp;page=2` loc is fetched literally, hitting a different URL than the
 * sitemap advertised.
 *
 * `&amp;` is decoded LAST so `&amp;lt;` yields the literal `&lt;` rather than
 * double-decoding to `<`.
 */
function decodeXmlEscapes(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

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
        .filter((loc): loc is string => Boolean(loc))
        .map(decodeXmlEscapes);

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
        "@_xmlns:news"?: string;
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
        const rawLoc = entry.loc?.trim();
        if (!rawLoc) continue;
        const loc = decodeXmlEscapes(rawLoc);

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
        // Namespace, not filename: `google-news-sitemap.xml` is convention, and a news sitemap served
        // from any path still declares xmlns:news. See SitemapData.isNewsSitemap for why it matters.
        isNewsSitemap: typeof urlset["@_xmlns:news"] === "string",
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

const SITEMAP_FETCH_TIMEOUT_MS = 30_000;

/**
 * How long the sitemap walk may go without completing a single fetch
 * (squirrelscan/repo#1733).
 *
 * The walk is the one preamble stage whose truncation costs PAGES, not just AX
 * metadata: cutting it short on a healthy site silently drops URLs the crawl
 * would have visited. So it is not governed by the root probes' shared ceiling,
 * which a site with many legitimate sitemaps would blow through honestly (60
 * one-URL sitemaps at ~4s a chunk is ~48s of perfectly good work).
 *
 * What separates that from the failure this issue is about is PROGRESS. A
 * stalled origin completes nothing, so the window expires after one dead chunk
 * and the walk stops; a slow-but-healthy origin keeps finishing chunks and
 * keeps earning a fresh window. Worst case for a stalled origin is therefore
 * roughly one chunk, not the whole walk.
 */
export const SITEMAP_WALK_WINDOW_MS = 20_000;
/** …and no more than this many full request timeouts, so a config asking for
 *  snappy requests gets a proportionally snappy walk. */
const WALK_WINDOW_REQUESTS = 3;

/** The walk's progress window for a given per-request timeout. */
export function sitemapWalkWindowMs(timeoutMs: number): number {
  return Math.min(SITEMAP_WALK_WINDOW_MS, Math.max(1, timeoutMs) * WALK_WINDOW_REQUESTS);
}

/** Mutable progress window shared across the recursive walk. */
interface WalkWindow {
  deadlineAt: number;
  /** Length of a fresh window, re-armed after each chunk that completes work. */
  windowMs: number;
}

function newWalkWindow(windowMs: number = SITEMAP_WALK_WINDOW_MS): WalkWindow {
  return { deadlineAt: Date.now() + windowMs, windowMs };
}

export function fetchSitemap(
  url: string,
  userAgent: string,
  customHeaders?: Record<string, string>,
  baseHost?: string,
  // squirrelscan/repo#1733: deadline for this one fetch, tightened by the
  // caller when the walk's progress window has less than a full timeout left.
  timeoutMs: number = SITEMAP_FETCH_TIMEOUT_MS,
): Effect.Effect<SitemapFetchResult, never, never> {
  // #1393: the caller's secret customHeaders are scoped to the audited origin. A
  // `Sitemap:` directive (robots.txt) or child-sitemap reference can point at an
  // off-origin host, so only forward them when the target host matches baseHost.
  // When baseHost is unset (direct callers/tests), preserve prior behavior.
  const originScopedHeaders =
    baseHost !== undefined && new URL(url).host !== baseHost ? undefined : customHeaders;
  return Effect.promise(async (): Promise<SitemapFetchResult> => {
    if (timeoutMs <= 0) return { success: false, url, error: SITEMAP_NOT_REACHED_ERROR };
    try {
      // #1395: manual redirects — per-hop scheme allowlist + strip secret
      // customHeaders on cross-origin redirects (native redirect:"follow" leaks them).
      // The deadline covers the body read too: a sitemap index that answers 200
      // and then stalls its body would otherwise park the crawl forever (#1699).
      return await safeFetchWithDeadline(
        url,
        {
          headers: {
            "User-Agent": userAgent,
            Accept: "application/xml, text/xml, */*",
            "Accept-Language": "en-US,en;q=0.9",
            ...originScopedHeaders,
          },
          redirect: "follow",
        },
        timeoutMs,
        async (response): Promise<SitemapFetchResult> => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return { success: false, url, error: `HTTP ${response.status}` };
          }
          // A body that never arrives (including a deadline abort) classifies
          // as "Empty response", the same as one that arrives empty. This text
          // reaches persisted sitemap-failure records, so it stays what it was
          // before the read moved inside the deadline.
          let content: string;
          try {
            content = await response.text();
          } catch {
            return { success: false, url, error: "Empty response" };
          }
          if (!content) return { success: false, url, error: "Empty response" };
          return { success: true, data: parseSitemap(content, url) };
        },
      );
    } catch (error) {
      return {
        success: false,
        url,
        error: error instanceof Error ? error.message : "Network error",
      };
    }
  });
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
  // #1393: host of the audited origin; customHeaders are only forwarded to
  // matching-host sitemap fetches. Threaded through the recursion.
  baseHost?: string,
  // squirrelscan/repo#1733: progress window shared across the whole walk, so a
  // stalled origin ends the descent after one dead chunk while a slow-but-
  // healthy one keeps going. Created on the first call and threaded down.
  walkWindow: WalkWindow = newWalkWindow(),
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
      // The window can expire PARTWAY through a level, and the entry guard
      // above only runs on the way in. Without this, an index listing thousands
      // of children would still be chunked and awaited one skip-result at a
      // time after the walk had already given up.
      const remainingMs = walkWindow.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        logger.debug(
          "sitemap walk made no progress, skipping remaining sitemaps",
          `${unseenUrls.length - i} skipped at depth ${currentDepth}`,
        );
        break;
      }

      const chunk = unseenUrls.slice(i, i + SITEMAP_FETCH_CONCURRENCY);
      const chunkTimeoutMs = Math.min(SITEMAP_FETCH_TIMEOUT_MS, remainingMs);
      const chunkResults = yield* Effect.all(
        chunk.map((url) => fetchSitemap(url, userAgent, customHeaders, baseHost, chunkTimeoutMs)),
        { concurrency: SITEMAP_FETCH_CONCURRENCY },
      );
      fetchResults.push(...chunkResults);
      // A completed fetch earns a fresh window. Only successes count, and that
      // is deliberate: an all-404 level answers in milliseconds and finishes
      // inside the first window regardless, so the window only ever bites a walk
      // that is BOTH slow and getting nothing — which is the stall.
      if (chunkResults.some((result) => result.success)) {
        walkWindow.deadlineAt = Date.now() + walkWindow.windowMs;
      }

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
      baseHost,
      walkWindow,
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
  /**
   * The walk gave up before visiting every entry point, so `discovered` being
   * empty is NOT evidence that the site has no sitemap (squirrelscan/repo#1733).
   * Consumers must report unknown rather than missing when this is set.
   */
  truncated: boolean;
}

export interface DiscoverSitemapsOptions {
  /** Stop fetching further sitemaps once this many URLs have been parsed */
  maxUrls?: number;
  /** Custom HTTP headers attached to every sitemap fetch (e.g. Web Bot Auth signatures). */
  customHeaders?: Record<string, string>;
  /**
   * How long the walk may go without completing a fetch before it gives up.
   * Defaults to SITEMAP_WALK_WINDOW_MS; pass `sitemapWalkWindowMs(timeoutMs)` to
   * scale it with a crawl's per-request timeout (squirrelscan/repo#1733).
   */
  walkWindowMs?: number;
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

    // #1393: robots.txt is untrusted page content. A `Sitemap:` directive can
    // carry any scheme/host — reject non-http(s) targets (a `file://` sitemap
    // would otherwise be fetched and its body parsed/stored). Off-origin http(s)
    // sitemaps are still fetched (legit CDN case) but without customHeaders,
    // enforced by the baseHost gate passed to fetchSitemapsRecursive below.
    const baseHost = new URL(baseUrl).host;
    if (robotsTxt?.sitemaps) {
      for (const sitemap of robotsTxt.sitemaps) {
        try {
          const resolvedUrl = new URL(sitemap, baseUrl).toString();
          if (!isHttpOrHttpsUrl(resolvedUrl)) {
            logger.debug(`Non-http(s) sitemap URL in robots.txt skipped: ${sitemap}`);
            continue;
          }
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
      baseHost,
      newWalkWindow(options.walkWindowMs),
    );

    const allSitemaps = allResults.filter((result) => result.success).map((result) => result.data);
    const entryPointSet = new Set(entryPoints);
    const discovered = allSitemaps.filter((sitemap) => entryPointSet.has(sitemap.url));

    const sourceOf = (url: string) =>
      robotsSitemaps.has(url) ? ("robots.txt" as const) : ("common" as const);

    const failed: SitemapFetchFailure[] = allResults
      .filter(
        (result): result is { success: false; url: string; error: string } =>
          !result.success && entryPointSet.has(result.url),
      )
      .map((result) => ({ url: result.url, source: sourceOf(result.url), error: result.error }));

    // An entry point with NO result at all was never visited — the walk stopped
    // first. Record each one rather than letting it vanish, so "we did not look"
    // is never silently indistinguishable from "there was nothing there".
    const attempted = new Set(
      allResults.map((result) => (result.success ? result.data.url : result.url)),
    );
    const unvisited = entryPoints.filter((url) => !attempted.has(url));
    for (const url of unvisited) {
      failed.push({ url, source: sourceOf(url), error: SITEMAP_NOT_REACHED_ERROR });
    }

    return { discovered, all: allSitemaps, failed, truncated: unvisited.length > 0 };
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
