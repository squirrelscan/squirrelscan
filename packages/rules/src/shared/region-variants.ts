// Reciprocal hreflang region variants for the duplicate title and description
// rules (squirrelscan/squirrelscan#489).
//
// Localized pages for one language in different regions (en-gb and en-us,
// de-de, de-at and de-ch) often share a title and description by design. When
// they list each other as hreflang alternates, search engines treat them as one
// page served per region, so reporting them as duplicates is noise. These rules
// therefore merge such a pair into one entity before deciding whether a group
// of identical titles or descriptions is a duplicate.
//
// A pair is merged only when all of these hold:
//
//  - Reciprocal: A lists B as an alternate and B lists A. A one-way reference
//    proves nothing about B.
//  - Same language: the hreflang A gives B and the one B gives A share a
//    primary language subtag (`en` in `en-gb`). A `de`/`en` pair with one
//    title usually means an untranslated page, which is worth reporting.
//    `x-default` names no language and never counts.
//  - Neither page canonicalises elsewhere. A missing canonical counts as
//    self-referencing, as it does for Google; a canonical to another URL (or
//    one that does not parse) means the page is not the version being indexed.
//
// Both rule paths feed the same values in (the page's stored URL, raw
// canonical and parser-extracted alternates), so they merge identically. A page
// with no stored alternates (parsed before the field existed) merges with
// nothing, which is the behaviour before #489.
//
// Only pages already in a duplicate group are indexed: a page with a unique
// title cannot be merged into anything, and holding up to 100 alternates for
// every page of a large multi-locale site is the resident set the streaming
// path exists to avoid. So the rules group first and index second.

import type { HreflangAlternate, SiteQuery } from "@squirrelscan/core-contracts";
import { normalizePageUrl } from "@squirrelscan/utils/url";

import type { ParsedPage } from "../types";

/** Page identity for comparing URLs, or null when the URL does not parse. */
function identity(url: string, base?: string): string | null {
  try {
    return normalizePageUrl(new URL(url, base).href);
  } catch {
    return null;
  }
}

/** Primary language subtag (`en` in `en-gb`), or null for `x-default` and junk. */
function primaryLanguage(hreflang: string): string | null {
  const value = hreflang.trim().toLowerCase();
  if (!value || value === "x-default") return null;
  return value.split(/[-_]/)[0] || null;
}

export class RegionVariantIndex {
  /** Index the in-memory pages whose URL is in `urls` (the legacy path). */
  static fromPages(
    pages: Iterable<{ url: string; parsed: ParsedPage }>,
    urls: Iterable<string>,
  ): RegionVariantIndex {
    const wanted = new Set(urls);
    const index = new RegionVariantIndex();
    if (wanted.size === 0) return index;
    for (const page of pages) {
      if (!wanted.has(page.url)) continue;
      index.add(page.url, page.parsed.meta.canonical, page.parsed.hreflangAlternates);
    }
    return index;
  }

  /**
   * Index the stored rows whose URL is in `urls` (the streaming path). A second
   * cursor pass, made only when there is a duplicate group to check.
   */
  static async fromSiteQuery(
    siteQuery: SiteQuery,
    urls: Iterable<string>,
  ): Promise<RegionVariantIndex> {
    const wanted = new Set(urls);
    const index = new RegionVariantIndex();
    if (wanted.size === 0) return index;
    for await (const row of siteQuery.pagesMatching((r) => wanted.has(r.normalizedUrl))) {
      index.add(row.normalizedUrl, row.canonical, row.hreflangAlternates);
    }
    return index;
  }

  // Page identity -> (alternate identity -> primary languages the page gives it).
  // Only pages that may be merged at all (alternates, and no canonical elsewhere).
  private readonly declared = new Map<string, Map<string, Set<string>>>();

  /** Record one page's alternates. */
  add(
    url: string,
    canonical: string | null | undefined,
    alternates: readonly HreflangAlternate[] | null | undefined,
  ): void {
    if (!alternates || alternates.length === 0) return;
    const self = identity(url);
    if (!self) return;
    const declaredCanonical = canonical?.trim();
    if (declaredCanonical && identity(declaredCanonical, url) !== self) return;

    const targets = new Map<string, Set<string>>();
    for (const alt of alternates) {
      const lang = primaryLanguage(alt.hreflang);
      const target = identity(alt.href);
      if (!lang || !target || target === self) continue;
      let langs = targets.get(target);
      if (!langs) {
        langs = new Set();
        targets.set(target, langs);
      }
      langs.add(lang);
    }
    if (targets.size > 0) this.declared.set(self, targets);
  }

  /** Whether `a` and `b` are reciprocal same-language variants of one page. */
  private isVariantPair(a: string, b: string): boolean {
    // What `a` calls `b` is b's language; what `b` calls `a` is a's language.
    const bLangs = this.declared.get(a)?.get(b);
    const aLangs = this.declared.get(b)?.get(a);
    if (!bLangs || !aLangs) return false;
    for (const lang of bLangs) if (aLangs.has(lang)) return true;
    return false;
  }

  /**
   * How many distinct pages `urls` holds once region variants are merged. Two
   * URLs with the same identity but no variant link stay separate, so this never
   * merges more than the hreflang annotations say.
   */
  distinctCount(urls: readonly string[]): number {
    if (this.declared.size === 0) return urls.length;
    const ids = urls.map((url) => identity(url));
    const positions = new Map<string, number[]>();
    ids.forEach((id, i) => {
      if (id === null) return;
      const list = positions.get(id);
      if (list) list.push(i);
      else positions.set(id, [i]);
    });

    const parent = urls.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };

    ids.forEach((id, i) => {
      const targets = id === null ? undefined : this.declared.get(id);
      if (!targets) return;
      for (const target of targets.keys()) {
        if (!this.isVariantPair(id!, target)) continue;
        for (const j of positions.get(target) ?? []) parent[find(i)] = find(j);
      }
    });

    let count = 0;
    parent.forEach((_, i) => {
      if (find(i) === i) count++;
    });
    return count;
  }

  /** Keep only groups that still hold two or more distinct pages. */
  withoutVariantOnlyGroups<T>(groups: readonly T[], urlsOf: (group: T) => readonly string[]): T[] {
    return groups.filter((group) => this.distinctCount(urlsOf(group)) > 1);
  }
}
