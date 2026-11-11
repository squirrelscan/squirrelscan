// content/duplicate-content - indexable pages that share identical body content (#1690)
//
// page_features.contentHash covers the whole normalised HTML (title and canonical
// included), so it cannot see "different titles, same body". This rule instead keys
// on a fingerprint of the rendered body text, built once per page while its DOM is
// live (collected-signals.ts) or, on the legacy path, from the parsed document by the
// same helper. Exact matches only: near-duplicates are out of scope.
//
// Both paths feed one pure function (`buildCheck`), so output is identical. The
// streaming path groups fingerprints in memory and reads page metadata (status,
// noindex, canonical, hreflang) only for the groups that hold two or more pages.

import type { CheckResult, Rule, RuleContext, RuleResult } from "../types";
import type { HreflangAlternate, SiteQuery } from "@squirrelscan/core-contracts";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import { noindexSource } from "../shared/noindex";
import { identity, RegionVariantIndex } from "../shared/region-variants";
import { getRenderedProseText } from "./text-content";

/** Pages with fewer body words are left out (empty shells, login walls). Fixed, not configurable. */
export const MIN_WORDS = 100;
/** URLs listed per group; the rest are counted in `omittedUrls`. */
export const MAX_URLS_PER_GROUP = 20;
/** Groups reported as items; the rest are counted in `omittedGroups`. */
export const MAX_GROUPS = 50;

/** Query parameters that never change what a page says, sorted. `utm_*` is handled by prefix. */
export const TRACKING_PARAMS: readonly string[] = [
  "_ga",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref",
  "wbraid",
  "yclid",
];
const TRACKING_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);

export const URL_FORM_NOTE =
  "URL form (tracking parameters, trailing slash or letter case) is the cause: add a canonical tag or redirect to one form";

const SKIP_CHECK: CheckResult = {
  name: "duplicate-content",
  status: "skipped",
  message: "Insufficient pages to check for duplicate content",
};

export interface ContentFingerprint {
  /** 64-bit hash (two 32-bit lanes) of the lowercased, whitespace-collapsed body text, hex. */
  hash: string;
  /** Whitespace-separated token count of that text. */
  words: number;
}

function isSpaceCode(c: number): boolean {
  return (
    c <= 32 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the page's rendered body text, or null when the document has no
 * body. One plain loop (no regex over page text): two independent 32-bit lanes in
 * the cyrb53 style over the lowercased text with each whitespace run read as one space.
 */
export function buildContentFingerprint(doc: Document): ContentFingerprint | null {
  let body: Element | null = null;
  try {
    body = doc.body;
  } catch {
    return null;
  }
  if (!body) return null;

  const text = getRenderedProseText(body).toLowerCase();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let words = 0;
  let inWord = false;
  const mix = (c: number): void => {
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isSpaceCode(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      if (words > 0) mix(32);
      words++;
      inWord = true;
    }
    mix(c);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return { hash: hex32(h2) + hex32(h1), words };
}

/** A page whose finalUrl is a different page than the one requested (a redirect). */
export function isRedirectedPage(url: string, finalUrl: string | null | undefined): boolean {
  return !!finalUrl && normalizePageUrl(finalUrl) !== normalizePageUrl(url);
}

/** Fingerprint for the collector and the legacy path: null for a redirect or a page without a body. */
export function fingerprintForPage(
  doc: Document | null | undefined,
  url: string,
  finalUrl: string | null | undefined,
): ContentFingerprint | null {
  if (!doc || isRedirectedPage(url, finalUrl)) return null;
  return buildContentFingerprint(doc);
}

/** Pagination by the same markers as crawl/pagination: page|p|pg|offset|start params, or a trailing /page/N. */
export function isPaginatedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    const k = key.toLowerCase();
    if (k === "page" || k === "p" || k === "pg" || k === "offset" || k === "start") return true;
  }
  const segs = parsed.pathname.split("/");
  while (segs.length > 0 && segs[segs.length - 1] === "") segs.pop();
  const last = segs[segs.length - 1];
  if (segs.length < 2 || segs[segs.length - 2]!.toLowerCase() !== "page" || !last) return false;
  for (let i = 0; i < last.length; i++) {
    const c = last.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** URL with tracking params dropped, trailing slash stripped and case folded, or the lowercased input if it does not parse. */
export function urlFormKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.toLowerCase();
  }
  const kept: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    const k = key.toLowerCase();
    if (TRACKING_SET.has(k) || k.startsWith("utm_")) continue;
    kept.push(JSON.stringify([k, value]));
  }
  kept.sort();
  let end = parsed.pathname.length;
  while (end > 1 && parsed.pathname.charCodeAt(end - 1) === 47) end--;
  const path = parsed.pathname.slice(0, end) || "/";
  return JSON.stringify([parsed.origin, path, kept]).toLowerCase();
}

/** The page metadata the grouping needs, identical whichever path supplies it. */
export interface PageMeta {
  status: number;
  noindex: boolean;
  canonical: string | null | undefined;
  alternates: readonly HreflangAlternate[] | null | undefined;
}

export interface ContentInput {
  /** url -> fingerprint for every page that has one. */
  fingerprints: ReadonlyMap<string, ContentFingerprint>;
  /** url -> metadata, for the urls in hash groups of two or more. */
  meta: ReadonlyMap<string, PageMeta>;
}

interface Group {
  hash: string;
  words: number;
  urls: string[];
  urlFormOnly: boolean;
  urlFormVariants: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Hash -> urls (sorted) over pages with enough words, plus the count of thin pages. */
function groupByHash(fingerprints: ReadonlyMap<string, ContentFingerprint>): {
  groups: Map<string, { words: number; urls: string[] }>;
  thin: number;
  candidates: number;
} {
  const groups = new Map<string, { words: number; urls: string[] }>();
  let thin = 0;
  let candidates = 0;
  for (const [url, fp] of fingerprints) {
    if (fp.words < MIN_WORDS) {
      thin++;
      continue;
    }
    candidates++;
    const g = groups.get(fp.hash);
    if (g) g.urls.push(url);
    else groups.set(fp.hash, { words: fp.words, urls: [url] });
  }
  return { groups, thin, candidates };
}

/** Urls in hash groups of two or more: the only pages whose metadata is needed. */
export function urlsNeedingMeta(
  fingerprints: ReadonlyMap<string, ContentFingerprint>,
): Set<string> {
  const out = new Set<string>();
  for (const g of groupByHash(fingerprints).groups.values()) {
    if (g.urls.length > 1) for (const u of g.urls) out.add(u);
  }
  return out;
}

/** The one pure function both paths feed. */
export function buildCheck(input: ContentInput): CheckResult {
  const { groups: byHash, thin, candidates } = groupByHash(input.fingerprints);
  if (input.fingerprints.size === 0 || candidates < 2) return SKIP_CHECK;

  const excluded = { noindex: 0, notOk: 0, pagination: 0, hreflang: 0, thin };
  let canonicalised = 0;
  const found: Group[] = [];

  for (const [hash, g] of byHash) {
    if (g.urls.length < 2) continue;
    const kept: string[] = [];
    for (const url of g.urls) {
      const meta = input.meta.get(url);
      if (!meta || meta.status < 200 || meta.status > 299) excluded.notOk++;
      else if (meta.noindex) excluded.noindex++;
      else if (isPaginatedUrl(url)) excluded.pagination++;
      else kept.push(url);
    }
    if (kept.length < 2) continue;

    // Where each page says it lives; a missing or unparseable canonical is the page itself.
    const canonicals = new Set<string>();
    for (const url of kept) {
      const self = identity(url) ?? url;
      const declared = input.meta.get(url)?.canonical?.trim();
      canonicals.add((declared ? identity(declared, url) : null) ?? self);
    }
    if (canonicals.size < 2) {
      canonicalised++;
      continue;
    }

    if (countComponents(kept, input.meta) < 2) {
      excluded.hreflang += kept.length;
      continue;
    }

    const sorted = [...kept].sort(cmp);
    const keys = new Set(sorted.map(urlFormKey));
    found.push({
      hash,
      words: g.words,
      urls: sorted,
      urlFormOnly: keys.size === 1,
      urlFormVariants: sorted.length - keys.size,
    });
  }

  if (found.length === 0) {
    return {
      name: "duplicate-content",
      status: "pass",
      message: "No pages share identical body content",
      details: { excluded, canonicalisedGroups: canonicalised, minWords: MIN_WORDS },
    };
  }

  found.sort((a, b) => b.urls.length - a.urls.length || cmp(a.urls[0]!, b.urls[0]!));
  const totalPages = found.reduce((sum, g) => sum + g.urls.length, 0);
  const shown = found.slice(0, MAX_GROUPS);
  return {
    name: "duplicate-content",
    status: "warn",
    message: `${found.length} duplicate content group(s) found across ${totalPages} pages`,
    items: shown.map((g) => {
      const listed = g.urls.slice(0, MAX_URLS_PER_GROUP);
      const note = g.urlFormOnly
        ? `: ${URL_FORM_NOTE}`
        : g.urlFormVariants > 0
          ? ` (${g.urlFormVariants} differ only by URL form: tracking parameters, trailing slash or letter case)`
          : "";
      return {
        id: g.hash,
        label: `${g.urls.length} pages share identical content (${g.words} words)${note}`,
        sourcePages: listed,
        meta: {
          pageCount: g.urls.length,
          words: g.words,
          urlFormOnly: g.urlFormOnly,
          urlFormVariants: g.urlFormVariants,
          listedUrls: listed.length,
          omittedUrls: g.urls.length - listed.length,
        },
      };
    }),
    details: {
      totalGroups: found.length,
      totalPages,
      reportedGroups: shown.length,
      omittedGroups: found.length - shown.length,
      urlFormGroups: found.filter((g) => g.urlFormOnly).length,
      canonicalisedGroups: canonicalised,
      excluded,
      minWords: MIN_WORDS,
    },
  };
}

/** Distinct pages once pages listing each other as hreflang alternates (any language) are joined. */
function countComponents(urls: readonly string[], metas: ReadonlyMap<string, PageMeta>): number {
  // No alternates anywhere: nothing can join, and the pairwise scan below is quadratic in the group size.
  if (!urls.some((u) => (metas.get(u)?.alternates?.length ?? 0) > 0)) return urls.length;
  const index = new RegionVariantIndex();
  for (const url of urls) {
    const m = metas.get(url);
    index.add(url, m?.canonical, m?.alternates);
  }
  const ids = urls.map((u) => identity(u));
  const parent = urls.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < urls.length; i++) {
    const a = ids[i];
    if (a === null || a === undefined) continue;
    for (let j = i + 1; j < urls.length; j++) {
      const b = ids[j];
      if (b === null || b === undefined) continue;
      if (index.areReciprocalIds(a, b)) parent[find(i)] = find(j);
    }
  }
  let count = 0;
  for (let i = 0; i < urls.length; i++) if (find(i) === i) count++;
  return count;
}

async function runStreaming(
  ctx: RuleContext,
  siteQuery: SiteQuery | undefined,
): Promise<RuleResult> {
  const fingerprints = new Map<string, ContentFingerprint>();
  for (const page of ctx.collectedSignals?.pages ?? []) {
    // Absent field: a record cached before the fingerprint existed is not judged.
    if (page.contentFingerprint) fingerprints.set(page.url, page.contentFingerprint);
  }
  const wanted = urlsNeedingMeta(fingerprints);
  const meta = new Map<string, PageMeta>();
  if (wanted.size > 0) {
    if (siteQuery) {
      for await (const row of siteQuery.pagesMatching((r) => wanted.has(r.normalizedUrl))) {
        meta.set(row.normalizedUrl, {
          status: row.status,
          noindex: row.robotsNoindex,
          canonical: row.canonical,
          alternates: row.hreflangAlternates,
        });
      }
    } else {
      addLegacyMeta(ctx, wanted, meta);
    }
  }
  return { checks: [buildCheck({ fingerprints, meta })] };
}

function addLegacyMeta(
  ctx: RuleContext,
  wanted: ReadonlySet<string>,
  meta: Map<string, PageMeta>,
): void {
  for (const page of ctx.site?.pages ?? []) {
    if (!wanted.has(page.url)) continue;
    meta.set(page.url, {
      status: page.statusCode,
      noindex: noindexSource(page.parsed, page.headers) !== null,
      canonical: page.parsed.meta?.canonical,
      alternates: page.parsed.hreflangAlternates,
    });
  }
}

function runLegacy(ctx: RuleContext): RuleResult {
  const fingerprints = new Map<string, ContentFingerprint>();
  const pages = ctx.site?.pages ?? [];
  for (const page of pages) {
    const fp = fingerprintForPage(page.parsed?.document, page.url, page.finalUrl);
    if (fp) fingerprints.set(page.url, fp);
  }
  const meta = new Map<string, PageMeta>();
  addLegacyMeta(ctx, urlsNeedingMeta(fingerprints), meta);
  return { checks: [buildCheck({ fingerprints, meta })] };
}

export const duplicateContentRule: Rule = {
  meta: {
    id: "content/duplicate-content",
    name: "Duplicate Content",
    description:
      "Finds indexable pages whose body content is identical and that do not resolve to one canonical",
    solution:
      "Pages with identical body content compete with each other in search. Point every copy at one canonical URL with a rel=canonical tag, redirect the extra URLs to it, or rewrite the pages so each says something different. If the copies differ only by tracking parameters, a trailing slash or letter case, canonicalise or redirect to one URL form.",
    category: "content",
    scope: "site",
    severity: "warning",
    weight: 5,
  },

  run(ctx: RuleContext): RuleResult | Promise<RuleResult> {
    if (ctx.collectedSignals) return runStreaming(ctx, ctx.siteQuery);
    return runLegacy(ctx);
  },
};
