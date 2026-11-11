// content/duplicate-content - different URLs serving identical body content

import { z } from "zod";

import type { CheckItem, SiteQuery } from "@squirrelscan/core-contracts";
import { isPageIndexable } from "@squirrelscan/utils";

import { RegionVariantIndex } from "../shared/region-variants";
import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";

const DEFAULT_MIN_WORDS = 50;
const MAX_GROUPS_LISTED = 50;
const MAX_URLS_PER_GROUP = 25;

const SKIP_CHECK: CheckResult = {
  name: "duplicate-content",
  status: "skipped",
  message: "Insufficient pages to check for duplicate content",
};

/** The same tracking parameters `url/parameters` names. */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "source",
]);

/** The URL forms `crawl/pagination` reads: a page parameter, or `/page/N`. */
const PAGINATION_PARAM = /[?&](?:page|p|pg|offset|start)=/i;
const PAGINATION_PATH = /\/page\/\d+\/?$/;

export function isPaginatedUrl(url: string): boolean {
  if (PAGINATION_PARAM.test(url)) return true;
  try {
    return PAGINATION_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export type UrlFormCause = "tracking-parameters" | "trailing-slash" | "letter-case";

/**
 * When every URL of a group is one URL written differently, the causes: tracking
 * parameters, a trailing slash, letter case. Null when the URLs differ in more than
 * form (a group of distinct pages). Each cause is listed only if undoing it changed
 * at least one member.
 */
export function urlFormCauses(urls: readonly string[]): UrlFormCause[] | null {
  const parsed: URL[] = [];
  for (const raw of urls) {
    try {
      parsed.push(new URL(raw));
    } catch {
      return null;
    }
  }
  const causes: UrlFormCause[] = [];
  const stripTracking = (u: URL): string => {
    const copy = new URL(u.href);
    copy.hash = "";
    for (const key of [...copy.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) copy.searchParams.delete(key);
    }
    return copy.href;
  };
  const noHash = parsed.map((u) => {
    const c = new URL(u.href);
    c.hash = "";
    return c.href;
  });
  let current = parsed.map(stripTracking);
  if (current.some((value, i) => value !== noHash[i])) causes.push("tracking-parameters");

  const stripSlash = (value: string): string => {
    const u = new URL(value);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.href;
  };
  const afterSlash = current.map(stripSlash);
  if (afterSlash.some((value, i) => value !== current[i])) causes.push("trailing-slash");
  current = afterSlash;

  const lowered = current.map((value) => value.toLowerCase());
  if (lowered.some((value, i) => value !== current[i])) causes.push("letter-case");

  return new Set(lowered).size === 1 && causes.length > 0 ? causes : null;
}

interface Member {
  url: string;
  /** The canonical this page declares, or its own identity when it declares none. */
  canonical: string;
}

interface DuplicateGroup {
  members: Member[];
}

/** A group resolves when every page names the same canonical (a missing one means itself). */
function resolvesToOneCanonical(members: readonly Member[]): boolean {
  return new Set(members.map((m) => m.canonical)).size === 1;
}

/**
 * The canonical a page effectively declares: its own `rel=canonical` resolved against
 * the page and without a fragment, or the page's own URL when it declares none. Compared
 * as written, with no slash or case folding: a trailing-slash twin that canonicalises
 * to itself is a second URL for the page, which is the finding.
 */
function effectiveCanonical(url: string, canonical: string | null | undefined): string {
  if (!canonical) return url;
  try {
    const resolved = new URL(canonical, url);
    resolved.hash = "";
    return resolved.href;
  } catch {
    return canonical;
  }
}

const causeLabel: Record<UrlFormCause, string> = {
  "tracking-parameters": "tracking parameters",
  "trailing-slash": "a trailing slash",
  "letter-case": "letter case",
};

function buildCheck(groups: DuplicateGroup[], minWords: number): CheckResult {
  if (groups.length === 0) {
    return { name: "duplicate-content", status: "pass", message: "No duplicate content found" };
  }
  const ordered = groups
    .map((g) => ({ urls: g.members.map((m) => m.url).sort() }))
    .sort((a, b) => b.urls.length - a.urls.length || (a.urls[0]! < b.urls[0]! ? -1 : 1));
  const pages = ordered.reduce((sum, g) => sum + g.urls.length, 0);
  const items: CheckItem[] = ordered.slice(0, MAX_GROUPS_LISTED).map((g) => {
    const causes = urlFormCauses(g.urls);
    return {
      id: g.urls[0]!,
      label: causes
        ? `${g.urls.length} URLs for one page: the URL form is the cause (${causes.map((c) => causeLabel[c]).join(", ")})`
        : `${g.urls.length} pages with identical content`,
      sourcePages: g.urls.slice(0, MAX_URLS_PER_GROUP),
      meta: {
        pageCount: g.urls.length,
        ...(g.urls.length > MAX_URLS_PER_GROUP ? { additionalPages: g.urls.length - MAX_URLS_PER_GROUP } : {}),
        ...(causes ? { urlFormCause: causes } : {}),
      },
    };
  });
  return {
    name: "duplicate-content",
    status: "warn",
    message: `${ordered.length} group(s) of duplicate content across ${pages} pages`,
    items,
    details: {
      groups: ordered.length,
      pages,
      minWords,
      ...(ordered.length > MAX_GROUPS_LISTED ? { additional: ordered.length - MAX_GROUPS_LISTED } : {}),
    },
  };
}

/** What a page contributes, whichever path read it. */
interface Candidate {
  url: string;
  hash: string | null | undefined;
  status: number;
  /** meta or X-Robots-Tag noindex. */
  noindex: boolean;
  words: number | null | undefined;
  canonical: string;
}

/** The groups that stay after the left-out pages and the single-canonical groups are dropped. */
function candidateGroups(candidates: Iterable<Candidate>, minWords: number): DuplicateGroup[] {
  const byHash = new Map<string, Member[]>();
  for (const c of candidates) {
    if (!c.hash) continue;
    if (c.status < 200 || c.status > 299) continue;
    if (c.noindex) continue;
    if ((c.words ?? 0) < minWords) continue;
    if (isPaginatedUrl(c.url)) continue;
    const members = byHash.get(c.hash) ?? [];
    members.push({ url: c.url, canonical: c.canonical });
    byHash.set(c.hash, members);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of byHash.values()) {
    if (members.length > 1 && !resolvesToOneCanonical(members)) groups.push({ members });
  }
  return groups;
}

const urlsOf = (group: DuplicateGroup): string[] => group.members.map((m) => m.url);

async function runViaSiteQuery(siteQuery: SiteQuery, minWords: number): Promise<RuleResult> {
  if (siteQuery.pageCount() < 2) return { checks: [SKIP_CHECK] };

  const candidates: Candidate[] = [];
  for await (const row of siteQuery.pagesMatching(() => true)) {
    if (!row.contentHash) continue;
    candidates.push({
      url: row.normalizedUrl,
      hash: row.contentHash,
      status: row.status,
      noindex: row.robotsNoindex || row.indexableReasons.length > 0,
      words: row.wordCount,
      canonical: effectiveCanonical(row.normalizedUrl, row.canonical),
    });
  }
  const groups = candidateGroups(candidates, minWords);
  // Reciprocal same-language hreflang pairs are one page served per region.
  const variants = await RegionVariantIndex.fromSiteQuery(siteQuery, groups.flatMap(urlsOf));
  return { checks: [buildCheck(variants.withoutVariantOnlyGroups(groups, urlsOf), minWords)] };
}

function runViaPages(pages: NonNullable<RuleContext["site"]>["pages"], minWords: number): RuleResult {
  if (pages.length < 2) return { checks: [SKIP_CHECK] };
  const candidates: Candidate[] = [];
  for (const page of pages) {
    if (!page.contentHash) continue;
    candidates.push({
      url: page.url,
      hash: page.contentHash,
      status: page.statusCode,
      noindex: !isPageIndexable(page.parsed, page.headers).isIndexable,
      words: page.parsed.content?.wordCount,
      canonical: effectiveCanonical(page.url, page.parsed.meta?.canonical),
    });
  }
  const groups = candidateGroups(candidates, minWords);
  const variants = RegionVariantIndex.fromPages(pages, groups.flatMap(urlsOf));
  return { checks: [buildCheck(variants.withoutVariantOnlyGroups(groups, urlsOf), minWords)] };
}

export const duplicateContentRule: Rule = {
  meta: {
    id: "content/duplicate-content",
    name: "Duplicate Content",
    description: "Finds indexable pages that serve identical body content without one shared canonical",
    solution:
      "When several URLs serve the same content and do not canonicalise to one of them, search engines pick one themselves and split signals between the copies. Pick the URL you want indexed and point every copy's rel=canonical at it, or redirect the copies with a 301 or 308. If the copies differ only by tracking parameters, a trailing slash or letter case, fix the URL form: link to one form everywhere and redirect the rest. Pages that are meant to differ (paginated lists, locale variants) should keep self-referencing canonicals and, for locales, reciprocal hreflang. Only exact matches of the stored content hash (the page HTML with whitespace normalised) are found; near-duplicates are out of scope.",
    category: "content",
    scope: "site",
    severity: "warning",
    weight: 4,
    optionsSchema: z.object({
      minWords: z
        .number()
        .int()
        .min(0)
        .default(DEFAULT_MIN_WORDS)
        .describe("Pages with fewer words are left out, so empty shells and login walls do not form a group"),
    }),
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    const minWords = typeof ctx.options.minWords === "number" ? ctx.options.minWords : DEFAULT_MIN_WORDS;
    if (ctx.siteQuery) return runViaSiteQuery(ctx.siteQuery, minWords);
    const pages = ctx.site?.pages;
    return pages ? runViaPages(pages, minWords) : { checks: [SKIP_CHECK] };
  },
};
