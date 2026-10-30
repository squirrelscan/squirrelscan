// Query-string variants of a page counted with their canonical (#858).
//
// `/contact` and `/contact?subject=Billing` are two crawled pages, and the same
// template finding made two affected pages. A crawled page whose `rel=canonical`
// resolves to a DIFFERENT crawled page of the same site with the same path is a
// variant of it: the report counts it under that page. A page with no canonical,
// a self canonical or a canonical elsewhere (another path, host or an uncrawled
// URL) is its own page, so search, pagination and filter pages with their own
// canonical stay separate. Report time only: nothing is fetched differently and
// every page still gets its own checks, so tallies and the score do not move.

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";

/** `https://host/path` with a trailing slash dropped, or undefined for a URL that does not parse. */
function pathKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 1 && parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/**
 * Variant page -> the crawled page it declares as canonical. `pages` are the crawled
 * pages' URLs (the report's identity for a page) with their declared canonical.
 */
export function canonicalVariantMap(
  pages: ReadonlyArray<{ url: string; canonical?: string | null }>,
): Map<string, string> {
  const crawled = new Set<string>();
  for (const page of pages) crawled.add(page.url);
  const variants = new Map<string, string>();
  for (const page of pages) {
    if (!page.canonical) continue;
    let target: string;
    try {
      target = new URL(page.canonical, page.url).href;
    } catch {
      continue;
    }
    const own = pathKey(page.url);
    if (own === undefined || pathKey(target) !== own) continue;
    // The declared canonical must itself be a crawled page of this audit (compared with and
    // without a trailing slash and fragment), and not this page.
    const withoutHash = target.split("#")[0]!;
    const candidates = [withoutHash, withoutHash.endsWith("/") ? withoutHash.slice(0, -1) : `${withoutHash}/`];
    const canonical = candidates.find((c) => crawled.has(c));
    if (canonical === undefined || canonical === page.url) continue;
    // A canonical that is itself a variant of another page folds into that page's target.
    variants.set(page.url, canonical);
  }
  // Resolve chains (a -> b -> c) and drop loops.
  const resolved = new Map<string, string>();
  for (const [variant, first] of variants) {
    let target = first;
    const seen = new Set([variant]);
    while (variants.has(target) && !seen.has(target)) {
      seen.add(target);
      target = variants.get(target)!;
    }
    if (!seen.has(target) && target !== variant) resolved.set(variant, target);
  }
  return resolved;
}

const mapPage = (url: string, map: ReadonlyMap<string, string>): string => map.get(url) ?? url;

const mapPages = (pages: string[], map: ReadonlyMap<string, string>): string[] => [...new Set(pages.map((p) => mapPage(p, map)))];

function foldItem(item: CheckItem, map: ReadonlyMap<string, string>): void {
  if (item.sourcePages) item.sourcePages = mapPages(item.sourcePages, map);
  // An item that IS a page (a page URL id, no sourcePages) counts under its canonical too.
  else if (map.has(item.id)) item.id = map.get(item.id)!;
}

/**
 * Count each check's pages under their canonical page, in place: `pageUrl`, `pages`, each
 * item's `sourcePages` (and an item that is itself a page). Idempotent, and safe on checks
 * shared between two lookups. Returns how many checks changed.
 */
export function foldChecksToCanonical(checks: Iterable<CheckResult>, map: ReadonlyMap<string, string>): number {
  if (map.size === 0) return 0;
  let changed = 0;
  for (const check of checks) {
    let touched = false;
    if (check.pageUrl && map.has(check.pageUrl)) {
      check.pageUrl = map.get(check.pageUrl)!;
      touched = true;
    }
    if (check.pages?.some((p) => map.has(p))) {
      check.pages = mapPages(check.pages, map);
      touched = true;
    }
    for (const item of check.items ?? []) {
      const before = item.sourcePages?.some((p) => map.has(p)) || (!item.sourcePages && map.has(item.id));
      if (before) {
        foldItem(item, map);
        touched = true;
      }
    }
    if (touched) changed += 1;
  }
  return changed;
}
