import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

/**
 * The bot-protection caveat (repo#2237). Sitting behind a WAF vendor is not evidence of anything;
 * being refused by it is. The caveat is built from the crawl's own refusal counts, so an audit
 * that fetched everything it asked for prints nothing, whatever vendor fronts the site.
 */

export interface RefusalStats {
  /** Fetches the server refused (403, bot wall). Includes the provider-marked ones. */
  pagesBlocked?: number;
  /** Challenge or block pages a provider served. A subset of `pagesBlocked`, so never added to it. */
  wafBlocked?: { total: number };
  /** Root fetches (robots.txt, sitemaps, ...) refused. Disjoint from `pagesBlocked`. */
  refusedFetches?: readonly unknown[];
}

/**
 * URLs the site refused, challenged or answered with a block page. Page refusals and root-fetch
 * refusals are separate sets, so they add up. A throttled root fetch (429, 430) is rate limiting,
 * not bot protection, so it does not count.
 */
export function refusedUrlCount(stats: RefusalStats | undefined): number {
  if (!stats) return 0;
  return (
    (stats.pagesBlocked ?? 0) +
    (stats.refusedFetches ?? []).filter(
      (r) => !isRateLimitStatus((r as { status?: number }).status)
    ).length
  );
}

/** The caveat to print, or undefined when nothing was refused. */
export function botProtectionNotice(
  stats: RefusalStats | undefined,
  provider?: string
): string | undefined {
  const refused = refusedUrlCount(stats);
  if (refused === 0) return undefined;
  const noun = refused === 1 ? "URL" : "URLs";
  const who = provider ? `${provider} protection` : "bot protection";
  return `Site ${who} refused ${refused} ${noun} - coverage may be reduced and results may be incomplete`;
}
