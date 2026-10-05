// Noindex pages and the rules that skip them (pub#457).
//
// A page its owner keeps out of the search index (robots meta or X-Robots-Tag
// noindex) has no search result to present, so the rules whose only job is that
// presentation (title, description, H1, duplicate titles and descriptions, orphan
// pages) would report noise there. Page rules opt in with `meta.skipOnNoindex`
// and the runner skips them; the site rules filter their own page sets through
// `excludesNoindexPage`.
//
// Skipping only makes sense on a site that is itself being indexed. When the
// whole host is out of search (a staging site, or a preview deployment, which
// Vercel, Netlify and Cloudflare Pages all mark with `X-Robots-Tag: noindex`),
// the index rules are exactly what such an audit is for. So the run skips noindex
// pages only when it KNOWS the site is indexable: `SiteData.siteIndexable`,
// computed once per run by `isSiteIndexable` so the page and site passes agree.
// Unknown (no homepage and no entry page fetched, or a caller that never set it)
// skips nothing, which is the behavior before #457.

import { isPageIndexable } from "@squirrelscan/utils";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import type { ParsedPage, SiteData } from "../types";

export type NoindexSource = "robots meta tag" | "X-Robots-Tag header";

/**
 * Where a page's noindex comes from, or null when it has none. The same test as
 * `page_features.robotsNoindex` and crawl/indexability (`isPageIndexable` without
 * robots.txt: a disallowed URL is not a noindex), so every reader agrees on which
 * pages are noindex.
 */
export function noindexSource(
  parsed: ParsedPage | null | undefined,
  headers: Record<string, string> | undefined,
): NoindexSource | null {
  if (!parsed) return null;
  const { reasons } = isPageIndexable(parsed, headers);
  if (reasons.includes("meta:noindex")) return "robots meta tag";
  if (reasons.includes("header:noindex")) return "X-Robots-Tag header";
  return null;
}

/** Host without a leading `www.`, so the apex and www homepages compare equal. */
function bareHost(url: URL): string {
  return url.host.toLowerCase().replace(/^www\./, "");
}

function parseUrl(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Query-preserving page identity, or null when the url does not parse. */
function pageIdentity(url: string | undefined): string | null {
  return parseUrl(url) ? normalizePageUrl(url!) : null;
}

/** A crawled page as the SiteData builders hold it. */
export interface SiteIndexablePage {
  url: string;
  finalUrl?: string;
  statusCode: number;
  parsed: ParsedPage;
  headers?: Record<string, string>;
}

/**
 * Whether the audited site is itself being indexed, judged from one reference
 * page:
 *
 * 1. the homepage: a page on the base URL's host (www or not, any scheme) at path
 *    `/` with no query string, so a noindex `/?s=term` search page or another
 *    host's root never stands in for it;
 * 2. when the homepage was not fetched (a deep-seeded or path-scoped audit, or a
 *    homepage that answered with an error), the page the audit started from:
 *    the crawl's seed or original URL, matched by its stored or final URL.
 *
 * Only pages that answered below 400 count as fetched. Returns false when any
 * reference page is noindex (an http/https or www/apex pair errs toward running
 * every rule), true when it was fetched and is indexable, and undefined when
 * neither the homepage nor the entry page was fetched.
 */
export function isSiteIndexable(
  pages: ReadonlyArray<SiteIndexablePage>,
  baseUrl: string,
  entryUrls: ReadonlyArray<string | undefined> = [],
): boolean | undefined {
  const fetched = pages.filter((page) => page.statusCode < 400);
  const verdict = (refs: SiteIndexablePage[]): boolean | undefined =>
    refs.length === 0
      ? undefined
      : !refs.some((page) => noindexSource(page.parsed, page.headers) !== null);

  const base = parseUrl(baseUrl);
  if (base) {
    const host = bareHost(base);
    const homepages = fetched.filter((page) => {
      const url = parseUrl(page.url);
      return url !== null && bareHost(url) === host && url.search === "" && url.pathname === "/";
    });
    const homepageVerdict = verdict(homepages);
    if (homepageVerdict !== undefined) return homepageVerdict;
  }

  const entries = new Set(entryUrls.map(pageIdentity).filter((id): id is string => id !== null));
  if (entries.size === 0) return undefined;
  return verdict(
    fetched.filter(
      (page) =>
        entries.has(pageIdentity(page.url) ?? "") || entries.has(pageIdentity(page.finalUrl) ?? ""),
    ),
  );
}

/** Whether this run skips noindex pages at all: only on a site known to be indexed. */
export function skipsNoindexPages(site: SiteData | undefined): boolean {
  return site?.siteIndexable === true;
}

/**
 * Whether a site rule leaves this page out of its page set: the run skips noindex
 * pages and this one is noindex. The streaming path reads the same answer from
 * `page_features.robots_noindex`, which `isPageIndexable` also computes.
 */
export function excludesNoindexPage(
  site: SiteData | undefined,
  parsed: ParsedPage | null | undefined,
  headers: Record<string, string> | undefined,
): boolean {
  return skipsNoindexPages(site) && noindexSource(parsed, headers) !== null;
}
