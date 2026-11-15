/**
 * The bot-protection caveat (repo#2237). Sitting behind a WAF vendor is not evidence of anything;
 * being refused by it is. The caveat is built from the crawl's own refusal counts, so an audit
 * that fetched everything it asked for prints nothing, whatever vendor fronts the site.
 */

export interface RefusalStats {
  /** Fetches the server refused (403, bot wall). Includes the provider-marked ones. */
  pagesBlocked?: number;
  /** Challenge or block pages a provider served. */
  wafBlocked?: { total: number };
  /** Root fetches (robots.txt, sitemaps, ...) refused. */
  refusedFetches?: readonly unknown[];
}

/** URLs the site refused, challenged or answered with a block page. */
export function refusedUrlCount(stats: RefusalStats | undefined): number {
  if (!stats) return 0;
  return Math.max(
    stats.pagesBlocked ?? 0,
    stats.wafBlocked?.total ?? 0,
    stats.refusedFetches?.length ?? 0
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
