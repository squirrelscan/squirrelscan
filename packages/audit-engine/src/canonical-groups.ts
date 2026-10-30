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

import { Effect } from "effect";

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import type { CrawlStorage } from "@squirrelscan/core-contracts/storage";

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
  // Resolve chains (a -> b -> c) and drop loops. Memoised: each page is walked once, so a long chain is linear.
  const resolved = new Map<string, string>();
  const done = new Set<string>();
  for (const start of variants.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let at = start;
    let target: string | undefined;
    while (variants.has(at) && !done.has(at) && !onPath.has(at)) {
      path.push(at);
      onPath.add(at);
      at = variants.get(at)!;
    }
    if (done.has(at)) target = resolved.get(at) ?? (variants.has(at) ? undefined : at);
    else if (onPath.has(at)) target = undefined; // a loop: none of it folds
    else target = at; // reached a page that is not itself a variant
    for (const url of path) {
      if (target !== undefined && target !== url) resolved.set(url, target);
      done.add(url);
    }
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
    const items = check.items;
    const itemsBefore = items?.length ?? 0;
    // Items the fold itself rewrote from a variant page (`/c?a=1` -> `/c`): only these can become
    // duplicates of another item. Every other item of the check is left exactly as it is.
    const rewritten = new Set<unknown>();
    for (const item of items ?? []) {
      const before = item.sourcePages?.some((p) => map.has(p)) || (!item.sourcePages && map.has(item.id));
      if (before) {
        if (!item.sourcePages) rewritten.add(item);
        foldItem(item, map);
        touched = true;
      }
    }
    // Two items that were two pages (/c and /c?a=1) are one item now: list it once, and the counts a
    // renderer reads from `details` follow the list. A rewritten item is dropped only when an item with
    // the same id and the same content is already listed; distinct items sharing an id stay.
    if (items && rewritten.size > 0) {
      const content = (item: CheckItem): string => JSON.stringify({ ...item, id: undefined });
      const seen = new Set<string>();
      const kept: CheckItem[] = [];
      for (const item of items) {
        const key = `${item.id}\u0000${content(item)}`;
        if (rewritten.has(item) && seen.has(key)) continue;
        seen.add(key);
        kept.push(item);
      }
      if (kept.length !== items.length) {
        check.items = kept;
        const details = check.details as Record<string, unknown> | undefined;
        if (details) {
          for (const key of ["count", "occurrences"]) {
            if (details[key] === itemsBefore) details[key] = kept.length;
          }
        }
      }
    }
    if (touched) changed += 1;
  }
  return changed;
}

/** Variant page -> canonical page for a crawl, from the stored page features; empty when the storage has none (#858). */
export function readCanonicalVariants(
  storage: CrawlStorage,
  crawlId: string,
  batchSize: number,
): Effect.Effect<Map<string, string>, never, never> {
  return Effect.gen(function* () {
    const reader = storage as unknown as {
      getPageFeaturesPage?: (
        crawlId: string,
        opts?: { after?: string; limit?: number },
      ) => Effect.Effect<Array<{ normalizedUrl: string; canonical: string | null }>, unknown, never>;
    };
    if (!reader.getPageFeaturesPage) return new Map<string, string>();
    const rows: Array<{ url: string; canonical: string | null }> = [];
    let after: string | undefined;
    for (;;) {
      const batch = yield* reader
        .getPageFeaturesPage(crawlId, { after, limit: batchSize })
        .pipe(Effect.catchAll(() => Effect.succeed([] as Array<{ normalizedUrl: string; canonical: string | null }>)));
      if (batch.length === 0) break;
      for (const row of batch) rows.push({ url: row.normalizedUrl, canonical: row.canonical });
      after = batch[batch.length - 1]!.normalizedUrl;
      if (batch.length < batchSize) break;
    }
    return canonicalVariantMap(rows);
  });
}
