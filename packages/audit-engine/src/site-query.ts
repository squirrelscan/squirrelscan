// SiteQuery factory (#1022, PR-B) — adapts the crawler SQLite storage into the
// bounded, read-only `SiteQuery` aggregate view threaded onto `ctx.siteQuery`.
//
// Site rules read these rollups INSTEAD of materializing `site.pages`, which is
// what lets a streaming audit score a large site without holding every parsed
// page resident (blueprint §2). Small aggregates are pre-materialized up front so
// the rule-facing methods stay synchronous; `pagesMatching` is an async cursor so
// a rare full scan never pins the whole page set.
//
// Nothing wires this into a production audit path yet — the streaming rule loop
// (#1021, PR-E) will construct it and pass it to `runner.runSiteRules`. It is
// exercised today only by the per-rule golden tests (dual-path parity gate).

import { Effect } from "effect";

import { normalizeUrl } from "@squirrelscan/utils";

import type { SQLiteStorage } from "@squirrelscan/crawler";
import type {
  DuplicateGroup,
  LinkData,
  PageFeatureDuplicateField,
  PageFeatureRow,
  PageRecord,
  SiteQuery,
  StorageError,
} from "@squirrelscan/core-contracts";

// Page-scan / cursor batch size. Bounds residency to one batch of pages while
// pre-materializing the incoming-link counts and while walking `pagesMatching`.
const PAGE_SCAN_BATCH = 500;

/**
 * Build a {@link SiteQuery} over one crawl's stored pages + page_features rows.
 *
 * Pre-materializes every bounded aggregate (incoming-link counts, duplicate /
 * template groups, page-type index, sums, homepage, count) so the returned
 * object's methods are synchronous. Reading is done through the PR-A page_features
 * read API plus a streaming scan of the pages table for the link graph.
 */
export function createSiteQuery(
  storage: SQLiteStorage,
  crawlId: string,
  opts?: {
    /**
     * The audit's page universe — the ordered `site.pages` normalized URLs v1
     * assembles (HTML + appended 4xx/5xx, WAF/non-HTML/redirect pages dropped;
     * adapter.ts assembleParsedUniverse). The streaming loop (#1021 E-E2) passes
     * this so the incoming-link graph's membership, iteration order, and link
     * SOURCES match v1's `site.pages` exactly. Omitted by the per-rule golden tests
     * (all-HTML-2xx fixtures) → falls back to the raw stored-pages set.
     */
    universe?: readonly string[];
  }
): Effect.Effect<SiteQuery, StorageError, never> {
  return Effect.gen(function* () {
    // Incoming internal-link counts — reconstructed from parsed page links, NOT
    // link_appearances (which stores only external links; see below).
    const incoming = yield* buildIncomingLinkCounts(storage, crawlId, opts?.universe);

    // page_features rollups (PR-A read API). All bounded by construction.
    const pageCount = yield* storage.getPageFeaturesCount(crawlId);
    const homepageRow = yield* storage.getHomepageFeature(crawlId);
    const dupTitle = yield* storage.getPageFeatureDuplicateGroups(crawlId, "title");
    const dupDesc = yield* storage.getPageFeatureDuplicateGroups(crawlId, "description");
    const dupContent = yield* storage.getPageFeatureDuplicateGroups(crawlId, "content");
    const templateGroups = yield* storage.getPageFeatureTemplateClusters(crawlId);
    const transferBytes = yield* storage.sumPageFeatureTransferBytes(crawlId);
    const secretHits = yield* storage.sumPageFeatureSecretHits(crawlId);
    const byType = yield* buildPagesByType(storage, crawlId);

    const duplicates: Record<PageFeatureDuplicateField, DuplicateGroup[]> = {
      title: dupTitle,
      description: dupDesc,
      content: dupContent,
    };

    return {
      pageCount: () => pageCount,
      incomingLinkCounts: () => incoming,
      homepage: () => homepageRow,
      duplicateGroups: (field) => duplicates[field] ?? [],
      templateClusters: () => templateGroups,
      pagesByType: (type) => byType.get(type) ?? [],
      sumTransferBytes: () => transferBytes,
      sumSecretHits: () => secretHits,
      pagesMatching: (pred) => iteratePagesMatching(storage, crawlId, pred),
    } satisfies SiteQuery;
  });
}

/**
 * Incoming internal-link counts, keyed by each crawled page's stored (normalized)
 * URL, in normalized_url order.
 *
 * IMPORTANT — sourced from parsed page links, NOT `link_appearances`. Both audit
 * adapters populate link_appearances with EXTERNAL links only (they store rows
 * behind an `!link.isInternal` guard), so `getAllIncomingLinkCounts()` would
 * return external targets — useless for internal orphan / weak-internal-link
 * detection. We rebuild the counts from `page.parsedData.links`, the exact source
 * the legacy rules read (`page.parsed.links`), applying identical filtering:
 * internal + has-url + dofollow, resolved against the page URL and normalized,
 * counted only when the target is itself a crawled page. The value for a page is
 * the count for its normalized URL, so pages that collapse to one normalized URL
 * (e.g. query-string variants) share a count exactly as the legacy Map does.
 *
 * PAGE-UNIVERSE RECONCILIATION (#1021 E-E2 (b)): when `universe` is supplied (the
 * streaming loop passes v1's assembled `site.pages` URLs), Pass A projects onto
 * exactly that set/order (HTML + appended 4xx/5xx, WAF/non-HTML/redirect pages
 * dropped) and Pass B counts links ONLY from pages in it — so membership, iteration
 * order, and link SOURCES match v1's `site.pages` exactly. Without it (the per-rule
 * golden tests' all-HTML-2xx fixtures) this walks the RAW stored-pages set, which is
 * byte-identical for those crawls but would include PDF/WAF/redirect pages a real
 * edge crawl carries. The 500-page golden-diff ground-truths the reconciled path.
 */
function buildIncomingLinkCounts(
  storage: SQLiteStorage,
  crawlId: string,
  universe?: readonly string[]
): Effect.Effect<Map<string, number>, StorageError, never> {
  return Effect.gen(function* () {
    const orderedUrls: string[] = [];
    // Keyed by normalizeUrl(page.url) — the legacy incoming-count bucket key.
    const bucket = new Map<string, number>();
    // Link SOURCES are restricted to the universe so a WAF-challenge page's links
    // (its parsedData is populated but v1 excludes it from site.pages) never inflate
    // a target's incoming count. Undefined → count from every stored page (legacy).
    const universeSet = universe ? new Set(universe) : null;

    // Pass A: the audit universe. With `universe` this is v1's site.pages set/order
    // exactly; otherwise the raw crawled-page set (getPages orders by normalized_url
    // ASC — the same order the legacy site.pages array carries).
    if (universe) {
      for (const url of universe) {
        orderedUrls.push(url);
        bucket.set(normalizeUrl(url), 0);
      }
    } else {
      yield* streamPages(storage, crawlId, (page) => {
        orderedUrls.push(page.normalizedUrl);
        bucket.set(normalizeUrl(page.normalizedUrl), 0);
      });
    }

    // Pass B: count internal dofollow links whose resolved+normalized target is a
    // crawled page. A second scan keeps at most one page batch resident (vs.
    // holding every page's links). Only pages in the universe are valid sources.
    yield* streamPages(storage, crawlId, (page) => {
      if (universeSet && !universeSet.has(page.normalizedUrl)) return;
      for (const link of parseLinks(page.parsedData)) {
        if (link.isInternal && link.url && !link.isNofollow) {
          try {
            const target = normalizeUrl(new URL(link.url, page.normalizedUrl).href);
            const current = bucket.get(target);
            if (current !== undefined) bucket.set(target, current + 1);
          } catch {
            // Invalid link URL — ignored, matching the legacy rules' try/catch.
          }
        }
      }
    });

    // Project normalized-URL buckets onto each page's stored identity URL, in
    // crawl order — mirrors the legacy `incomingLinkCount.get(normalizeUrl(page.url))`.
    const incoming = new Map<string, number>();
    for (const url of orderedUrls) {
      incoming.set(url, bucket.get(normalizeUrl(url)) ?? 0);
    }
    return incoming;
  });
}

/** Page-type index: normalized URLs per page_type, in normalized_url order. */
function buildPagesByType(
  storage: SQLiteStorage,
  crawlId: string
): Effect.Effect<Map<string, string[]>, StorageError, never> {
  return Effect.gen(function* () {
    const byType = new Map<string, string[]>();
    let after: string | undefined;
    for (;;) {
      const rows = yield* storage.getPageFeaturesPage(crawlId, {
        after,
        limit: PAGE_SCAN_BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.pageType) {
          const list = byType.get(row.pageType);
          if (list) list.push(row.normalizedUrl);
          else byType.set(row.pageType, [row.normalizedUrl]);
        }
      }
      if (rows.length < PAGE_SCAN_BATCH) break;
      after = rows[rows.length - 1]!.normalizedUrl;
    }
    return byType;
  });
}

/** Invoke `onPage` for every stored page, one batch resident at a time. */
function streamPages(
  storage: SQLiteStorage,
  crawlId: string,
  onPage: (page: PageRecord) => void
): Effect.Effect<void, StorageError, never> {
  return Effect.gen(function* () {
    let offset = 0;
    for (;;) {
      const batch = yield* storage.getPages(crawlId, {
        limit: PAGE_SCAN_BATCH,
        offset,
      });
      for (const page of batch) onPage(page);
      if (batch.length < PAGE_SCAN_BATCH) break;
      offset += PAGE_SCAN_BATCH;
    }
  });
}

/** Parse the stored parsedData blob's link list; [] for error/non-HTML pages. */
function parseLinks(parsedData: string | null): LinkData[] {
  if (!parsedData) return [];
  try {
    const parsed = JSON.parse(parsedData) as { links?: LinkData[] };
    return parsed.links ?? [];
  } catch {
    return [];
  }
}

/** Async cursor over page_features rows (normalized_url order), predicate-filtered. */
async function* iteratePagesMatching(
  storage: SQLiteStorage,
  crawlId: string,
  pred: (row: PageFeatureRow) => boolean
): AsyncIterable<PageFeatureRow> {
  let after: string | undefined;
  for (;;) {
    const rows = await Effect.runPromise(
      storage
        .getPageFeaturesPage(crawlId, { after, limit: PAGE_SCAN_BATCH })
        // A read failure mid-cursor is a hard error, not a silent truncation.
        .pipe(Effect.orDie)
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      if (pred(row)) yield row;
    }
    if (rows.length < PAGE_SCAN_BATCH) return;
    after = rows[rows.length - 1]!.normalizedUrl;
  }
}
