// SiteQuery factory (#1022, PR-B) — adapts the crawler SQLite storage into the
// bounded, read-only `SiteQuery` aggregate view threaded onto `ctx.siteQuery`.
//
// Site rules read these rollups INSTEAD of materializing `site.pages`, which is
// what lets a streaming audit score a large site without holding every parsed
// page resident (blueprint §2). Small aggregates are pre-materialized up front so
// the rule-facing methods stay synchronous; `pagesMatching` is an async cursor so
// a rare full scan never pins the whole page set.
//
// EDGES AND CLICK DEPTH (#1022): `outgoingEdges` streams every universe page's internal links
// (flags included) and `clickDepths` runs a bounded level-by-level BFS from given roots. Both
// never hold an adjacency map: edges stream a page batch at a time, and each BFS level reads only
// its frontier pages, so memory stays one batch plus the depth map.
//
// The streaming audit (`runStreamingRules` in adapter.ts) builds it and passes it to the site pass.

import type {
  AnchorGraph,
  ClickDepthNode,
  ClickDepthOptions,
  ClickDepthResult,
  DuplicateGroup,
  LinkData,
  LinkSectionCounts,
  OutgoingEdge,
  PageFeatureDuplicateField,
  PageFeatureRow,
  PageLinkRow,
  PageOutgoingEdges,
  SiteQuery,
  StorageError,
} from "@squirrelscan/core-contracts";
import type { SQLiteStorage } from "@squirrelscan/crawler";

import { AnchorGraphBuilder, countGenericAnchors } from "@squirrelscan/rules";
import { normalizeUrl } from "@squirrelscan/utils";
import { normalizePageUrl } from "@squirrelscan/utils/url";
import { Effect } from "effect";

// Cursor batch for the page_features reads, whose rows are small scalars.
const FEATURE_SCAN_BATCH = 500;

/**
 * Default batch for the pages scan. It reads two columns per page now
 * (`streamPageLinkRows`), not whole `PageRecord`s, so a batch costs the stored
 * parse rather than the page's HTML — tens of KB instead of ~1 MB each. The
 * default stays modest anyway: `parsedData` has no size ceiling, and a caller
 * that knows its memory ceiling passes `pageScanBatchSize`.
 */
const PAGE_SCAN_BATCH = 50;

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
    /**
     * Pages pulled per batch by the link-graph scan (#1860). The scan reads only
     * `normalized_url` + `parsed_data`, so this multiplies by the size of a
     * stored parse, not of a page; the cloud passes the same batch its other
     * streamed walks use. Unset → {@link PAGE_SCAN_BATCH}.
     */
    pageScanBatchSize?: number;
    /**
     * Build the anchor graph `links/anchor-mismatch` reads (#110). Default true; the audit passes
     * false when the rule is disabled, so no pair is collected for a rule that will not run, and
     * `anchorGraph()` is then absent.
     */
    anchorGraph?: boolean;
  }
): Effect.Effect<SiteQuery, StorageError, never> {
  return Effect.gen(function* () {
    // Incoming internal-link counts — reconstructed from parsed page links, NOT
    // link_appearances (which stores only external links; see below).
    // Clamped like every other streamed batch: `getPages` treats limit 0 as no
    // limit, which would pull the whole crawl and never advance the offset.
    const pageScanBatch = Math.max(
      1,
      opts?.pageScanBatchSize ?? PAGE_SCAN_BATCH
    );
    const incoming = yield* buildIncomingLinkCounts(
      storage,
      crawlId,
      opts?.universe,
      pageScanBatch,
      opts?.anchorGraph ?? true
    );

    // page_features rollups (PR-A read API). All bounded by construction.
    const pageCount = yield* storage.getPageFeaturesCount(crawlId);
    const homepageRow = yield* storage.getHomepageFeature(crawlId);
    const dupTitle = yield* storage.getPageFeatureDuplicateGroups(
      crawlId,
      "title"
    );
    const dupDesc = yield* storage.getPageFeatureDuplicateGroups(
      crawlId,
      "description"
    );
    const dupContent = yield* storage.getPageFeatureDuplicateGroups(
      crawlId,
      "content"
    );
    const templateGroups =
      yield* storage.getPageFeatureTemplateClusters(crawlId);
    const transferBytes = yield* storage.sumPageFeatureTransferBytes(crawlId);
    const secretHits = yield* storage.sumPageFeatureSecretHits(crawlId);
    const byType = yield* buildPagesByType(storage, crawlId);

    // Graph-key index over the audit universe (#1022): the first stored URL per key wins, like
    // the legacy rules' `byUrl`. `universeSet` mirrors Pass B: sources outside it are skipped.
    const winnerByKey = new Map<string, string>();
    for (const url of incoming.orderedUrls) {
      const key = normalizeUrl(url);
      if (!winnerByKey.has(key)) winnerByKey.set(key, url);
    }
    const universeSet = opts?.universe ? new Set(opts.universe) : null;

    const duplicates: Record<PageFeatureDuplicateField, DuplicateGroup[]> = {
      title: dupTitle,
      description: dupDesc,
      content: dupContent,
    };

    return {
      pageCount: () => pageCount,
      incomingLinkCounts: () => incoming.all,
      contextualIncomingLinkCounts: () => incoming.contextual,
      inboundSectionCounts: () => incoming.sections,
      genericAnchorCounts: () => incoming.genericAnchors,
      ...(incoming.anchorGraph
        ? { anchorGraph: () => incoming.anchorGraph! }
        : {}),
      homepage: () => homepageRow,
      duplicateGroups: (field) => duplicates[field] ?? [],
      templateClusters: () => templateGroups,
      pagesByType: (type) => byType.get(type) ?? [],
      sumTransferBytes: () => transferBytes,
      sumSecretHits: () => secretHits,
      pagesMatching: (pred) => iteratePagesMatching(storage, crawlId, pred),
      outgoingEdges: () =>
        iterateOutgoingEdges(
          storage,
          crawlId,
          pageScanBatch,
          winnerByKey,
          universeSet
        ),
      clickDepths: (entryUrls, depthOpts) =>
        computeClickDepths(
          storage,
          crawlId,
          pageScanBatch,
          winnerByKey,
          entryUrls,
          depthOpts
        ),
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
 * CONTEXTUAL VARIANT (#109): the same pass also accumulates a second bucket that
 * skips links flagged `isChrome` (anchor sat in a `nav`/`header`/`footer`/`aside`
 * landmark). Both maps are built in ONE scan and share every other filter, key
 * and iteration order, so `contextual <= all` holds per page by construction.
 * `isChrome === undefined` (a crawl stored before the flag existed) counts as
 * contextual — an old DB degrades to the pre-#109 numbers rather than reporting
 * every page as chrome-only.
 *
 * SECTIONS (#2307): the same pass counts the links per `LinkData.section`, under the same filters
 * and keys, so a page's section counts add up to at most its `all` count. Links with no section
 * (a crawl stored before link sections existed) and `unknown` ones add nothing.
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
  universe: readonly string[] | undefined,
  pageScanBatch: number,
  collectAnchors: boolean
): Effect.Effect<
  {
    all: Map<string, number>;
    contextual: Map<string, number>;
    sections: Map<string, LinkSectionCounts>;
    genericAnchors: Map<string, { generic: number; total: number }>;
    anchorGraph: AnchorGraph | null;
    orderedUrls: string[];
  },
  StorageError,
  never
> {
  return Effect.gen(function* () {
    const orderedUrls: string[] = [];
    // Keyed by normalizeUrl(page.url) — the legacy incoming-count bucket key.
    const bucket = new Map<string, number>();
    // Same keys; counts only links that did NOT sit in site chrome (#109).
    const contextualBucket = new Map<string, number>();
    // Same links, counted per link section (#2307). Only targets with a known section get an entry.
    const sectionBucket = new Map<string, LinkSectionCounts>();
    // Link SOURCES are restricted to the universe so a WAF-challenge page's links
    // (its parsedData is populated but v1 excludes it from site.pages) never inflate
    // a target's incoming count. Undefined → count from every stored page (legacy).
    const universeSet = universe ? new Set(universe) : null;
    // #110: contextual anchor text per (source, target) pair, plus each page's title and H1s.
    let anchors: AnchorGraphBuilder | null = null;
    // repo#1387: generic/total content anchors per source page, same universe as the link sources.
    const genericAnchors = new Map<
      string,
      { generic: number; total: number }
    >();

    // Pass A: the audit universe. With `universe` this is v1's site.pages set/order
    // exactly; otherwise the raw crawled-page set (getPages orders by normalized_url
    // ASC — the same order the legacy site.pages array carries).
    if (universe) {
      for (const url of universe) {
        orderedUrls.push(url);
        bucket.set(normalizeUrl(url), 0);
        contextualBucket.set(normalizeUrl(url), 0);
      }
    } else {
      yield* streamPageLinkRows(storage, crawlId, pageScanBatch, (page) => {
        orderedUrls.push(page.normalizedUrl);
        bucket.set(normalizeUrl(page.normalizedUrl), 0);
        contextualBucket.set(normalizeUrl(page.normalizedUrl), 0);
      });
    }

    // Created once the page universe is known: a link to anything else never uses the pair cap.
    if (collectAnchors) {
      anchors = new AnchorGraphBuilder(
        undefined,
        undefined,
        new Set(orderedUrls.map((u) => normalizePageUrl(u)))
      );
    }
    const anchorBuilder = anchors;

    // Pass B: count internal dofollow links whose resolved+normalized target is a
    // crawled page. A second scan keeps at most one page batch resident (vs.
    // holding every page's links). Only pages in the universe are valid sources.
    yield* streamPageLinkRows(storage, crawlId, pageScanBatch, (page) => {
      if (universeSet && !universeSet.has(page.normalizedUrl)) return;
      const parsed = parseLinkPage(page.parsedData);
      anchorBuilder?.addPage(page.normalizedUrl, {
        title: parsed.title,
        h1: parsed.h1,
        links: parsed.links,
        status: page.status,
        contentType: page.contentType,
      });
      genericAnchors.set(page.normalizedUrl, countGenericAnchors(parsed.links));
      for (const link of parsed.links) {
        if (link.isInternal && link.url && !link.isNofollow) {
          try {
            const target = normalizeUrl(
              new URL(link.url, page.normalizedUrl).href
            );
            const current = bucket.get(target);
            if (current !== undefined) {
              bucket.set(target, current + 1);
              if (!link.isChrome) {
                contextualBucket.set(
                  target,
                  (contextualBucket.get(target) ?? 0) + 1
                );
              }
              if (link.section && link.section !== "unknown") {
                let sections = sectionBucket.get(target);
                if (!sections) sectionBucket.set(target, (sections = {}));
                sections[link.section] = (sections[link.section] ?? 0) + 1;
              }
            }
          } catch {
            // Invalid link URL — ignored, matching the legacy rules' try/catch.
          }
        }
      }
    });

    // Project normalized-URL buckets onto each page's stored identity URL, in
    // crawl order — mirrors the legacy `incomingLinkCount.get(normalizeUrl(page.url))`.
    const all = new Map<string, number>();
    const contextual = new Map<string, number>();
    const sections = new Map<string, LinkSectionCounts>();
    for (const url of orderedUrls) {
      const key = normalizeUrl(url);
      all.set(url, bucket.get(key) ?? 0);
      contextual.set(url, contextualBucket.get(key) ?? 0);
      const placed = sectionBucket.get(key);
      if (placed) sections.set(url, placed);
    }
    return {
      all,
      contextual,
      sections,
      genericAnchors,
      anchorGraph: anchorBuilder ? anchorBuilder.build() : null,
      orderedUrls,
    };
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
        limit: FEATURE_SCAN_BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (row.pageType) {
          const list = byType.get(row.pageType);
          if (list) list.push(row.normalizedUrl);
          else byType.set(row.pageType, [row.normalizedUrl]);
        }
      }
      if (rows.length < FEATURE_SCAN_BATCH) break;
      after = rows[rows.length - 1]!.normalizedUrl;
    }
    return byType;
  });
}

/**
 * Invoke `onPage` for every stored page, one batch resident at a time, reading
 * ONLY the two columns this scan uses (#1860).
 *
 * The page's HTML is the whole cost here and none of it is read: `getPages`
 * would materialize ~1 MB per page (and pull it back out of the content store
 * when the column is empty) so the loop below can look at `parsedData.links`.
 * That memory is dropped at the end of each batch, but the allocator keeps the
 * pages it grew for it — measured over 150 real 959 KB pages at batch 50, three
 * runs, the two scans grew RSS a median 431 MB through `getPages` and 88 MB
 * through this, while the JS heap grew ~0.3 MB either way.
 */
function streamPageLinkRows(
  storage: SQLiteStorage,
  crawlId: string,
  batchSize: number,
  onPage: (page: PageLinkRow) => void
): Effect.Effect<void, StorageError, never> {
  return Effect.gen(function* () {
    let offset = 0;
    for (;;) {
      const batch = yield* storage.getPageLinkRows(crawlId, {
        limit: batchSize,
        offset,
      });
      for (const page of batch) onPage(page);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }
  });
}

/** Parse the stored parsedData blob's links, title and H1s; empty for error/non-HTML pages. */
function parseLinkPage(parsedData: string | null): {
  links: LinkData[];
  title: string | null;
  h1: string[];
} {
  if (!parsedData) return { links: [], title: null, h1: [] };
  try {
    const parsed = JSON.parse(parsedData) as {
      links?: LinkData[];
      meta?: { title?: string | null };
      h1?: { texts?: string[] };
    };
    return {
      links: parsed.links ?? [],
      title: parsed.meta?.title ?? null,
      h1: parsed.h1?.texts ?? [],
    };
  } catch {
    return { links: [], title: null, h1: [] };
  }
}

/** Graph keys of the internal links of one page that land on a universe page, in document order. */
function extractEdges(
  parsedData: string | null,
  sourceUrl: string,
  winnerByKey: ReadonlyMap<string, string>
): OutgoingEdge[] {
  const edges: OutgoingEdge[] = [];
  for (const link of parseLinkPage(parsedData).links) {
    if (!link.isInternal || !link.url) continue;
    try {
      const target = normalizeUrl(new URL(link.url, sourceUrl).href);
      if (winnerByKey.has(target)) {
        edges.push({
          target,
          nofollow: !!link.isNofollow,
          chrome: !!link.isChrome,
        });
      }
    } catch {
      // Invalid link URL: ignored, matching the legacy rules' try/catch.
    }
  }
  return edges;
}

/**
 * Read the stored rows of `urls` in chunks of `batchSize`, so one chunk of parses is resident at a
 * time (#1022). A URL with no stored page is skipped.
 */
async function readRowsByUrls(
  storage: SQLiteStorage,
  crawlId: string,
  batchSize: number,
  urls: readonly string[],
  onRow: (row: PageLinkRow) => void
): Promise<void> {
  for (let i = 0; i < urls.length; i += batchSize) {
    const rows = await Effect.runPromise(
      storage
        .getPageLinkRowsByUrls(crawlId, urls.slice(i, i + batchSize))
        .pipe(Effect.orDie)
    );
    for (const row of rows) onRow(row);
  }
}

/** Async cursor over every universe page's outgoing edges, one page batch resident at a time. */
async function* iterateOutgoingEdges(
  storage: SQLiteStorage,
  crawlId: string,
  batchSize: number,
  winnerByKey: ReadonlyMap<string, string>,
  universeSet: ReadonlySet<string> | null
): AsyncIterable<PageOutgoingEdges> {
  let offset = 0;
  for (;;) {
    const batch = await Effect.runPromise(
      storage
        .getPageLinkRows(crawlId, { limit: batchSize, offset })
        .pipe(Effect.orDie)
    );
    for (const row of batch) {
      if (universeSet && !universeSet.has(row.normalizedUrl)) continue;
      yield {
        source: row.normalizedUrl,
        sourceKey: normalizeUrl(row.normalizedUrl),
        status: row.status ?? null,
        edges: extractEdges(row.parsedData, row.normalizedUrl, winnerByKey),
      };
    }
    if (batch.length < batchSize) return;
    offset += batchSize;
  }
}

/**
 * Level-synchronous BFS over dofollow non-self internal links (#1022). Each level is one targeted
 * read of the frontier pages, so no adjacency map is ever built. See
 * `SiteQuery.clickDepths` for the limits.
 */
async function computeClickDepths(
  storage: SQLiteStorage,
  crawlId: string,
  batchSize: number,
  winnerByKey: ReadonlyMap<string, string>,
  entryUrls: readonly string[],
  opts: ClickDepthOptions
): Promise<ClickDepthResult> {
  const depths = new Map<string, ClickDepthNode>();
  const reached = new Set<string>();
  // Graph keys of nodes whose status has not been read from a row yet.
  const pending = new Set<string>();
  let truncated: ClickDepthResult["truncated"] = null;
  const maxNodes = Math.max(0, Math.floor(opts.maxNodes));
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth));

  let frontier = new Set<string>();
  for (const entry of entryUrls) {
    let key: string;
    try {
      key = normalizeUrl(entry);
    } catch {
      continue;
    }
    const winner = winnerByKey.get(key);
    if (winner === undefined || reached.has(key)) continue;
    if (depths.size >= maxNodes) {
      truncated = "maxNodes";
      break;
    }
    reached.add(key);
    depths.set(winner, { depth: 0, status: null });
    pending.add(key);
    frontier.add(key);
  }

  const winnerUrls = (keys: ReadonlySet<string>) =>
    [...keys].map((k) => winnerByKey.get(k)!);

  for (let depth = 0; truncated === null && frontier.size > 0; depth++) {
    const current = frontier;
    const full = depths.size >= maxNodes;
    const detectOnly = full || depth >= maxDepth;
    const next = new Set<string>();
    let more = false;
    let denied = false;
    await readRowsByUrls(
      storage,
      crawlId,
      batchSize,
      winnerUrls(current),
      (row) => {
        const key = normalizeUrl(row.normalizedUrl);
        const node = depths.get(row.normalizedUrl)!;
        node.status = row.status ?? null;
        pending.delete(key);
        if (detectOnly && more) return;
        for (const edge of extractEdges(
          row.parsedData,
          row.normalizedUrl,
          winnerByKey
        )) {
          if (edge.nofollow || edge.target === key || reached.has(edge.target))
            continue;
          if (detectOnly) {
            more = true;
            break;
          }
          if (depths.size >= maxNodes) {
            denied = true;
            continue;
          }
          reached.add(edge.target);
          depths.set(winnerByKey.get(edge.target)!, {
            depth: depth + 1,
            status: null,
          });
          pending.add(edge.target);
          next.add(edge.target);
        }
      }
    );
    if (detectOnly) {
      if (more) truncated = full ? "maxNodes" : "maxDepth";
      break;
    }
    if (denied) truncated = "maxNodes";
    frontier = next;
  }

  if (pending.size > 0) {
    await readRowsByUrls(
      storage,
      crawlId,
      batchSize,
      winnerUrls(pending),
      (row) => {
        depths.get(row.normalizedUrl)!.status = row.status ?? null;
      }
    );
  }
  return { depths, truncated };
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
        .getPageFeaturesPage(crawlId, { after, limit: FEATURE_SCAN_BATCH })
        // A read failure mid-cursor is a hard error, not a silent truncation.
        .pipe(Effect.orDie)
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      if (pred(row)) yield row;
    }
    if (rows.length < FEATURE_SCAN_BATCH) return;
    after = rows[rows.length - 1]!.normalizedUrl;
  }
}
