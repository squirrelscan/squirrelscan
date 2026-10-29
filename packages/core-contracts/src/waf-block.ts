/**
 * Pages a perimeter provider (WAF or bot manager) answered with a challenge or
 * block page instead of the site's content (squirrelscan/squirrelscan#1253).
 *
 * Such a page describes the provider, not the site, so it is never scored. A
 * blocked SEED page fails the whole audit: whatever else the crawl reached says
 * nothing trustworthy about a site whose front door refused us. Any other
 * blocked page is left out of rule evaluation and listed.
 *
 * Leaf module by design: the crawler records these, the engine derives the
 * audit status from them, and every report renderer reads them.
 */

/** Bounds the persisted and reported list: a hostile or walled site can block every page. */
export const MAX_WAF_BLOCKED_PAGES = 50;

export interface WafBlockedPage {
  /** The page URL the crawl asked for. Canonicalize before printing it. */
  url: string;
  /** The HTTP status the provider answered with. */
  status: number;
  /** The provider's display name, when the response named one. */
  provider: string | null;
  /** The provider id (`cloudflare`, `aws-waf`), when the response named one. */
  providerId: string | null;
  /** What matched, from the detector's fixed vocabulary: never a slice of the page. */
  signal: string;
  /** Machine-readable class: `blocked_by_<provider>`, or `blocked_by_waf` when unattributed. */
  code: string;
}

/** What the crawler records on `CrawlStats` and the report carries. */
export interface WafBlockedSummary {
  /** Every page the crawl saw blocked, including the ones past the list cap. */
  total: number;
  /** The audited page itself was blocked: the audit failed. */
  seed?: WafBlockedPage;
  /** The other blocked pages, capped at {@link MAX_WAF_BLOCKED_PAGES}. */
  pages: WafBlockedPage[];
  /** Distinct provider names, in first-seen order. */
  providers: string[];
}

/** `blocked_by_cloudflare`, `blocked_by_aws_waf`; `blocked_by_waf` when no provider was named. */
export function wafBlockCode(providerId: string | null | undefined): string {
  // split/filter/join, not a trailing-underscore regex: no backtracking at all.
  const slug = (providerId ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]/)
    .filter(Boolean)
    .join("_");
  return slug && slug !== "unknown" ? `blocked_by_${slug}` : "blocked_by_waf";
}

export function wafBlockedPage(input: {
  url: string;
  status: number;
  provider: string | null;
  providerId: string | null;
  signal: string;
}): WafBlockedPage {
  return { ...input, code: wafBlockCode(input.providerId) };
}

/** Fold one blocked page into a summary, never growing the list past its cap. */
export function addWafBlockedPage(
  summary: WafBlockedSummary | undefined,
  page: WafBlockedPage,
  isSeed: boolean,
): WafBlockedSummary {
  const next: WafBlockedSummary = summary
    ? { ...summary, pages: [...summary.pages], providers: [...summary.providers] }
    : { total: 0, pages: [], providers: [] };
  if (isSeed) {
    next.seed ??= page;
  } else if (
    next.pages.length < MAX_WAF_BLOCKED_PAGES &&
    !next.pages.some((p) => p.url === page.url)
  ) {
    next.pages.push(page);
  }
  next.total += 1;
  if (page.provider && !next.providers.includes(page.provider)) next.providers.push(page.provider);
  return next;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the site";
  }
}

/**
 * The one-sentence reason a seed block stores as `statusReason`. It starts with
 * the phrase `classifyAuditFailureReasonText` already reads as a refusal
 * (`blocked the crawler`), so the surfaces that only see the string classify it
 * as a site-side 4xx, and it names the class, the provider, the matched signal
 * and the status.
 */
export function wafBlockReason(page: WafBlockedPage): string {
  const who = page.provider ?? "a WAF or bot manager";
  return `Site blocked the crawler (bot protection / auth / rate limit): ${page.code}: ${who} served a challenge or block page (${page.signal}), HTTP ${page.status}, for ${hostOf(page.url)}`;
}

/**
 * What to do about a blocked audit, one line each. The first two are for the
 * site's owner; the third is for someone auditing a site that is not theirs.
 */
export const WAF_BLOCK_REMEDIES: readonly string[] = [
  "Allowlist the `SquirrelScan` user agent in the WAF or bot manager.",
  "Authorise the crawl: add the headers your WAF trusts under `[crawler] headers` in squirrel.toml.",
  "Set `user_agent` under `[crawler]` only on a site you are authorised to audit.",
  "Ask the site's owner to open the crawl for you.",
];

/** Where else to run it from. Separate because the HTML report prints its own run-it-locally line. */
export const WAF_BLOCK_NETWORK_REMEDY =
  "Run the audit from a network the site trusts, such as an office or home connection, or use the cloud crawler.";

/** One short sentence on why nothing was scored, shared by every renderer. */
export function wafBlockHeadline(page: WafBlockedPage): string {
  const who = page.provider ?? "A WAF or bot manager";
  return `${who} served a challenge or block page instead of ${hostOf(page.url)}, so nothing was audited (${page.code}).`;
}

/** The coverage line for blocked pages that did not stop the audit. */
export function wafBlockedPagesNotice(
  summary: Pick<WafBlockedSummary, "total" | "providers">,
  pagesAudited: number,
): string {
  const by = summary.providers.length > 0 ? ` by ${summary.providers.join(", ")}` : "";
  const of = pagesAudited + summary.total;
  return `${summary.total} of ${of} pages blocked${by}. Blocked pages were not audited and do not count in the score.`;
}
