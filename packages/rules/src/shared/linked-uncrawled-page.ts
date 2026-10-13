// A page the site links to but the crawl never fetched (pub#672).
//
// The E-E-A-T presence rules (privacy policy, about, contact) look for the page
// among the crawled pages. A crawl that excludes the path (`/policies/**` on a
// Shopify storefront), or stops at its page budget first, never fetches it, and
// "not crawled" then read as "missing": the rule advised creating a page that
// exists and is linked from every footer. A link is evidence the page exists,
// not proof it works, so these rules report it as linked but not checked.
//
// No requests are made here. The only status available is the one the internal
// link probe already recorded for a target the crawl did not fetch
// (`SiteData.linkTargetStatuses`); the probe never requests a path the crawl
// scope or robots.txt excludes.

import { normalizeUrl } from "@squirrelscan/utils";
import { isRateLimitStatus } from "@squirrelscan/utils/rate-limit";

import type { CheckResult, SiteData } from "../types";

/** How a link is recognised as pointing at the page a rule looks for. */
export interface LinkTargetMatcher {
  /** Whether the link's resolved, absolute URL is the page (slug match). */
  href: (url: string) => boolean;
  /** Whether the anchor text names the page. Read only when no href matches. */
  text?: (text: string) => boolean;
}

export interface LinkedUncrawledPage {
  /** Resolved URL of the link target. */
  url: string;
  /** The crawled page the link was found on. */
  linkedFrom: string;
  /** Whether the target was recognised by its href or only by its anchor text. */
  matchedBy: "href" | "text";
  /** Status the internal link probe recorded for the target, if it probed it. */
  probedStatus: number | null;
  /** The probe saw a 4xx or 5xx that is not a rate limit or an auth wall. */
  broken: boolean;
}

/** Only web links can be pages; `mailto:`, `tel:` and `javascript:` cannot. */
function webUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The first link on a crawled page that `matcher` recognises and whose target
 * the crawl did not fetch, or null. A target recognised by its href anywhere on
 * the site wins over one recognised only by anchor text, so a cookie banner's
 * "Privacy settings" link earlier in the DOM never beats the real policy link.
 * A target the crawl DID fetch is skipped: that page was checked, and the rule's
 * own page test already judged it.
 */
export function findLinkedUncrawledPage(
  site: Pick<SiteData, "pages" | "linkTargetStatuses">,
  matcher: LinkTargetMatcher,
): LinkedUncrawledPage | null {
  const crawled = new Set<string>();
  for (const page of site.pages) {
    crawled.add(normalizeUrl(page.url));
    if (page.finalUrl) crawled.add(normalizeUrl(page.finalUrl));
  }

  const find = (
    accepts: (link: { url: string; text: string }, resolved: string) => boolean,
  ): { url: string; linkedFrom: string } | null => {
    for (const page of site.pages) {
      for (const link of page.parsed?.links ?? []) {
        const resolved = webUrl(link.url, page.url);
        if (!resolved || crawled.has(normalizeUrl(resolved))) continue;
        if (accepts(link, resolved)) return { url: resolved, linkedFrom: page.url };
      }
    }
    return null;
  };

  let matchedBy: LinkedUncrawledPage["matchedBy"] = "href";
  let hit = find((_, resolved) => matcher.href(resolved));
  const matchText = matcher.text;
  if (!hit && matchText) {
    matchedBy = "text";
    hit = find((link) => matchText(link.text || ""));
  }
  if (!hit) return null;

  const key = normalizeUrl(hit.url);
  const probe = (site.linkTargetStatuses ?? []).find((p) => normalizeUrl(p.url) === key);
  const probedStatus = typeof probe?.status === "number" && probe.status > 0 ? probe.status : null;
  // A 401/403 is a bot wall or an auth wall refusing a status-only request, and
  // a 429/430 is throttling: neither says the page is missing (see links/broken-links).
  const broken =
    probedStatus !== null &&
    probedStatus >= 400 &&
    probedStatus !== 401 &&
    probedStatus !== 403 &&
    !probe?.rateLimited &&
    !isRateLimitStatus(probedStatus);

  return { ...hit, matchedBy, probedStatus, broken };
}

/**
 * The check a presence rule emits for a linked page the crawl did not fetch:
 * a warning when the link probe saw it fail, otherwise info, because nothing
 * was checked. `label` names the page as the rule's messages do ("About page").
 */
export function linkedUncrawledCheck(
  name: string,
  label: string,
  target: LinkedUncrawledPage,
): CheckResult {
  const details = {
    linkedFrom: target.linkedFrom,
    ...(target.probedStatus !== null ? { probedStatus: target.probedStatus } : {}),
  };
  if (target.broken) {
    return {
      name,
      status: "warn",
      message: `${label} link returns ${target.probedStatus}`,
      value: target.url,
      details,
    };
  }
  return {
    name,
    status: "info",
    message: `${label} linked but not crawled`,
    value: target.url,
    details,
  };
}
