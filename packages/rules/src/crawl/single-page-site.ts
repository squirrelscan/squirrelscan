// crawl/single-page-site - the whole site is one page with sections.
//
// A one-page site often means its sections (#about, #services, #contact) when it
// says "pages". Search engines index URLs, not fragments, so a section cannot
// rank, show in results or be cited on its own, and the whole site has one
// title, one description and one topic. That is a trade-off, not a defect: many
// one-page sites are deliberate. So the finding is informational only. It never
// moves a score: an `info` check is neither a pass nor a failure, and a run that
// does not fire returns no checks, which leaves the rule out of scoring.

import type { CheckItem } from "@squirrelscan/core-contracts";

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

import { normalizeUrl } from "@squirrelscan/utils";

import { anchorLookup } from "../links/broken-anchors";
import { decodeFragment, isJudgeableFragment } from "../links/page-anchors";

/** The fewest in-page links to ids that make a page a sectioned one. */
export const MIN_SECTION_LINKS = 3;

/** Section ids listed on the finding. */
const MAX_LISTED_SECTIONS = 10;

const NOT_APPLICABLE: RuleResult = { checks: [] };

const stripHash = (url: string): string => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

const hostKey = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Distinct in-scope sitemap URLs, so a one-entry sitemap listing the page itself counts as one. */
function inScopeSitemapUrls(ctx: RuleContext, baseUrl: string): number {
  const baseHost = hostKey(baseUrl);
  const seen = new Set<string>();
  for (const sitemap of ctx.site?.sitemaps?.discovered ?? []) {
    for (const entry of sitemap.urls) {
      if (hostKey(entry.loc) !== baseHost) continue;
      try {
        seen.add(normalizeUrl(stripHash(entry.loc)));
        // The rule only asks "more than one": stop reading a huge sitemap there.
        if (seen.size > 1) return seen.size;
      } catch {
        // A malformed entry is not a page.
      }
    }
  }
  return seen.size;
}

export const singlePageSiteRule: Rule = {
  meta: {
    id: "crawl/single-page-site",
    name: "Single-Page Site",
    description:
      "Notes when the whole site is one page with in-page sections, which search engines and AI agents see as one URL",
    solution:
      "Search engines index URLs, not fragments, so a section such as #services cannot rank, show up in results or be linked to from a search result on its own. The whole site also shares one title, one meta description and one topic signal, and AI agents and answer engines cite URLs, so there is one thing to cite. If any section is something you want found in search or cited by agents, give it its own page with its own title and description. If the single page is deliberate, nothing needs to change: this note never affects your score.",
    category: "crawl",
    scope: "site",
    // Advisory and weightless: see the header. Score-neutral by construction.
    severity: "info",
    weight: 1,
  },

  run(ctx: RuleContext): RuleResult {
    const site = ctx.site;
    const pages = site?.pages;
    if (!site || !pages || pages.length !== 1) return NOT_APPLICABLE;

    // The crawl has to be complete: a capped run (or one that did not follow
    // links, or left queued URLs unfetched) may just not have reached the rest.
    const limits = site.crawlLimits;
    // A site with exactly maxPages pages reads as capped too: the safe side. It
    // only bites at max_pages 1, where a one-page audit proves nothing.
    if (limits && limits.pagesCrawled >= limits.maxPages) return NOT_APPLICABLE;
    if (site.linkDiscoveryOff === true) return NOT_APPLICABLE;
    if ((site.unfetchedPages ?? 0) > 0) return NOT_APPLICABLE;

    const page = pages[0]!;
    if (page.statusCode < 200 || page.statusCode >= 300 || !page.parsed) return NOT_APPLICABLE;

    if (inScopeSitemapUrls(ctx, site.baseUrl) > 1) return NOT_APPLICABLE;

    // Any link to another same-site path, even one that 404s, means the site
    // has more than this page.
    const ownKeys = new Set<string>([normalizeUrl(stripHash(page.url))]);
    if (page.finalUrl) ownKeys.add(normalizeUrl(stripHash(page.finalUrl)));
    for (const link of page.parsed.links ?? []) {
      if (!link.isInternal || !link.url) continue;
      let key: string;
      try {
        key = normalizeUrl(stripHash(link.url));
      } catch {
        continue;
      }
      if (!ownKeys.has(key)) return NOT_APPLICABLE;
    }

    // Sections: same-page fragment links whose target id exists on the page.
    const record = anchorLookup(ctx, pages)(normalizeUrl(page.url));
    if (!record || record.idsTruncated) return NOT_APPLICABLE;
    const ids = new Set(record.ids);
    const found = new Set<string>();
    for (const raw of record.selfFragments) {
      const fragment = decodeFragment(raw);
      if (isJudgeableFragment(fragment) && ids.has(fragment)) found.add(fragment);
    }
    const sections = [...found];
    if (sections.length < MIN_SECTION_LINKS) return NOT_APPLICABLE;

    const listed = sections.slice(0, MAX_LISTED_SECTIONS);
    const items: CheckItem[] = listed.map((id) => ({ id: `#${id}` }));
    const check: CheckResult = {
      name: "single-page-site",
      status: "info",
      message: `This site is one page with ${sections.length} in-page sections (${listed.map((s) => `#${s}`).join(", ")}${sections.length > listed.length ? ", ..." : ""}). Search engines and AI agents see one URL, not ${sections.length} pages`,
      pageUrl: page.url,
      value: sections.length,
      items,
      details: {
        sections: sections.length,
        ...(sections.length > listed.length ? { additional: sections.length - listed.length } : {}),
      },
    };
    return { checks: [check] };
  },
};
