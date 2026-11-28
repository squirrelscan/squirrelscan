// The per-page scalars the sitemap, hreflang and E-E-A-T site rules read (#2309).
//
// These rules used to walk `ctx.site.pages` and read each parsed page. They now read one
// bounded `SitePageView` per page instead: the streaming engine builds the views once and hands
// them over as `ctx.siteQuery.pageViews()`, and a context without a siteQuery (tests, embedders,
// the v1 engine) gets the same views derived here from `site.pages`. Both come from
// `buildSitePageView`, so the two paths cannot disagree about a page.

import type {
  SitePageView,
  SitePageViewLink,
} from "@squirrelscan/core-contracts";

import { flattenJsonLdNodes } from "@squirrelscan/utils";

import type { RuleContext, SiteData } from "../types";

import { buildHreflangSignal } from "../i18n/hreflang-signal";
import { hasAffiliateLink } from "./affiliate-links";
import { countAuthoritativeLinks } from "./authoritative-links";
import { noindexSource } from "./noindex";
import { pagePrimaryDate } from "./page-date";
import { isProductPage, linksToCart } from "./product-page";
import { didRedirect, documentUrl } from "./redirect-evidence";

type SitePage = SiteData["pages"][number];

/** The view of one `site.pages` entry. Reads parsed scalars only, never `parsed.document`. */
export function buildSitePageView(page: SitePage): SitePageView {
  const parsed = page.parsed;
  const allLinks = parsed?.links ?? [];

  const links: SitePageViewLink[] = [];
  const seen = new Set<string>();
  let hasMailto = false;
  let hasTel = false;
  for (const link of allLinks) {
    if (link.url.startsWith("mailto:")) hasMailto = true;
    if (link.url.startsWith("tel:")) hasTel = true;
    const text = link.text || "";
    const key = JSON.stringify([link.url, text, link.isInternal]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url: link.url, text, isInternal: link.isInternal });
  }

  const nodes = parsed?.schema?.raw
    ? flattenJsonLdNodes(parsed.schema.raw)
    : [];
  const signal = buildHreflangSignal(parsed, page.headers, page.url);
  const chain = page.redirectChain;

  return {
    url: page.url,
    ...(page.finalUrl !== undefined ? { finalUrl: page.finalUrl } : {}),
    status: page.statusCode,
    redirectSource: page.redirectSource === true,
    hasParsed: !!parsed,
    documentUrl: documentUrl(page),
    redirected: didRedirect(page.url, page.finalUrl, chain),
    redirectFinalUrl: chain?.finalUrl ?? page.finalUrl ?? null,
    title: parsed?.meta?.title ?? null,
    description: parsed?.meta?.description ?? null,
    h1: parsed?.h1?.texts ?? [],
    wordCount: parsed?.content?.wordCount ?? 0,
    schemaTypes: [...new Set(parsed?.schema?.types ?? [])],
    aboutSchema: parsed?.schemas?.hasType?.("AboutPage") ?? false,
    contactSchema: parsed?.schemas?.hasType?.("ContactPage") ?? false,
    links,
    hasMailto,
    hasTel,
    authoritativeLinks: countAuthoritativeLinks(allLinks),
    affiliateLink: hasAffiliateLink(allLinks),
    productPage: isProductPage(page),
    cartLink: linksToCart(page),
    hasAuthor: (parsed?.author ?? null) !== null,
    schemaAuthor: nodes.some((n) => n["author"]),
    schemaDatePublished: nodes.some((n) => n["datePublished"]),
    schemaDateModified: nodes.some((n) => n["dateModified"]),
    visibleAuthor: parsed?.visibleAuthor ?? null,
    visibleDatePublished: parsed?.visibleDatePublished ?? null,
    visibleDateModified: parsed?.visibleDateModified ?? null,
    pageType: parsed?.pageType ?? null,
    pageDate: parsed ? pagePrimaryDate(parsed) : null,
    noindex: noindexSource(parsed, page.headers),
    hreflang: signal,
  };
}

/**
 * The page views a site rule reads, in crawl order: the engine's `siteQuery.pageViews()` when it
 * supplies them, else views derived from `site.pages`. Redirect sources are left out unless the
 * rule is redirect-aware, as the runner leaves them out of `site.pages` for every other rule.
 * Undefined when there is nothing to read.
 */
export function sitePageViews(
  ctx: RuleContext,
  opts?: { redirectAware?: boolean }
): readonly SitePageView[] | undefined {
  const supplied = ctx.siteQuery?.pageViews?.();
  const views = supplied ?? ctx.site?.pages?.map(buildSitePageView);
  if (!views) return undefined;
  if (opts?.redirectAware) return views;
  return supplied ? views.filter((v) => !v.redirectSource) : views;
}
