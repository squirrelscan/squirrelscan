// Direct-storage mode — writes a SiteModel straight into the crawler's SQLite
// storage via the public CrawlStorage API (no raw SQL), so engine tests can
// run rules over a large crawl DB in seconds without an actual HTTP crawl.
//
// Streams one page at a time: render → upsert → let the HTML string go out of
// scope before the next page, so a 25k-page write stays bounded in memory
// regardless of per-page target size.

import type {
  CrawlStatus,
  LinkAppearanceRecord,
  PageRecord,
  ResponseHeaders,
  SecurityHeaders,
} from "@squirrelscan/core-contracts";

import { Effect } from "effect";

import type { SiteModel } from "./types";

import { SQLiteStorage } from "@squirrelscan/crawler/storage";
import { parsePage } from "@squirrelscan/parser";

import { absoluteHref, buildRobotsTxt, linkText, renderPageHtml } from "./html-render";
import { hashString32, hashStringHex } from "./prng";

export interface WriteCrawlOptions {
  /** Synthetic origin used to build absolute page/link URLs. Default "http://synthetic.test". */
  baseUrl?: string;
  crawlStatus?: CrawlStatus;
  /** Upsert pages in batches within a transaction for speed at 25k scale. Default 200. */
  batchSize?: number;
  /**
   * Epoch ms used for crawl/page/robots/sitemap timestamps. Defaults to a
   * value derived from `model.seed` (not Date.now()) so two writes of the
   * same model produce byte-identical timestamps — load-bearing for any
   * future hash-comparison of generated fixture DBs.
   */
  now?: number;
}

// A fixed reference epoch (2026-01-01T00:00:00Z) plus a seed-derived offset —
// deterministic, stable across runs, and distinct per seed without depending
// on wall-clock time.
const REFERENCE_EPOCH_MS = 1_767_225_600_000;

function deterministicTimestamp(seed: string): number {
  return REFERENCE_EPOCH_MS + (hashString32(seed) % 86_400_000);
}

export interface WriteCrawlResult {
  crawlId: string;
  pageCount: number;
  linkAppearanceCount: number;
}

const EMPTY_HEADERS: ResponseHeaders = {
  contentType: null,
  contentEncoding: null,
  cacheControl: null,
  vary: null,
  etag: null,
  server: null,
  lastModified: null,
  link: null,
  serverTiming: null,
  age: null,
  xCache: null,
  cfCacheStatus: null,
  xVercelCache: null,
  altSvc: null,
  acceptRanges: null,
};

const EMPTY_SECURITY_HEADERS: SecurityHeaders = {
  hsts: null,
  csp: null,
  xFrameOptions: null,
  xContentTypeOptions: null,
  referrerPolicy: null,
  permissionsPolicy: null,
  xRobotsTag: null,
};

function run<A>(eff: Effect.Effect<A, unknown, never>): Promise<A> {
  return Effect.runPromise(eff as Effect.Effect<A, never, never>);
}

// upsertPage/addLinkAppearancesBatch are Effect.try wrappers around synchronous
// bun:sqlite calls (no real async work), so Effect.runSync is safe here and
// lets a batch of them run inside one storage.transaction() — same "batch
// ~200" convention the streaming-engine blueprint uses for the real crawl
// loop — instead of paying an autocommit fsync per row at 25k scale.
function runSync<A>(eff: Effect.Effect<A, unknown, never>): A {
  return Effect.runSync(eff as Effect.Effect<A, never, never>);
}

const DEFAULT_BATCH_SIZE = 200;

// A batch pre-renders all its pages' HTML before the transaction runs (so the
// transaction body stays synchronous — see runSync above), so batchSize alone
// doesn't bound peak transient memory when maxPageSizeBytes is large (the
// activera-incident class, up to ~1.25MB/page). Cap batch BYTES too, and let
// that shrink the effective row count for large-page configs — 200 pages *
// 1.25MB would otherwise transiently hold ~250MB just for one batch.
const MAX_BATCH_BYTES = 20_000_000;

function effectiveBatchSize(configuredBatchSize: number, maxPageSizeBytes: number): number {
  const byBytes = Math.max(1, Math.floor(MAX_BATCH_BYTES / Math.max(1, maxPageSizeBytes)));
  return Math.max(1, Math.min(configuredBatchSize, byBytes));
}

/**
 * Mirrors the real crawler's write-path classification EXACTLY (packages/parser/src/extractors/links.ts:142-145,
 * the only logic that governs what actually lands in `link_appearances` —
 * NOT packages/utils' `isInternalUrl`, which compares full origin and is
 * unused on this path): plain hostname string equality against the page's
 * own URL, no origin/port/www normalization. Every page in a SiteModel
 * shares `baseUrl`'s host, so comparing against `baseUrl`'s hostname once is
 * equivalent to the real per-page `page.finalUrl` comparison, just cheaper.
 */
function isExternalHref(href: string, baseUrl: string, baseHostname: string): boolean {
  return new URL(absoluteHref(href, baseUrl)).hostname !== baseHostname;
}

/**
 * BFS depth from home ("/") over the resolvable (query-stripped) link graph,
 * ALSO following `redirectTo` — a redirect hop's PageModel has empty
 * `outgoingLinks` (the chain is expressed purely via `redirectTo`), so
 * without this a hop past hop-0 is unreachable by the outgoing-links-only
 * walk and silently falls back to depth 0 (same as the homepage).
 */
function computeDepths(model: SiteModel): Map<string, number> {
  const byPath = new Map(model.pages.map((p) => [p.path, p]));
  const depths = new Map<string, number>();
  const home = model.pages.find((p) => p.path === "/");
  if (!home) return depths;

  depths.set(home.path, 0);
  const queue: string[] = [home.path];
  let head = 0;
  while (head < queue.length) {
    const path = queue[head++]!;
    const page = byPath.get(path);
    if (!page) continue;
    const depth = depths.get(path)!;
    const targetPaths: string[] = page.outgoingLinks.map(
      (href) => (href.split("?")[0] ?? href).split("#")[0]!,
    );
    if (page.redirectTo) targetPaths.push(page.redirectTo);
    for (const targetPath of targetPaths) {
      if (!byPath.has(targetPath) || depths.has(targetPath)) continue;
      depths.set(targetPath, depth + 1);
      queue.push(targetPath);
    }
  }
  return depths;
}

/**
 * Writes `model` into a fresh SQLite crawl DB at `storagePath`. Returns the
 * still-open {@link SQLiteStorage} so callers can query it immediately
 * (important for `:memory:` paths, which only exist for the life of the
 * connection) — the caller owns closing it, mirroring createTestStorage().
 */
export async function writeCrawlToStorage(
  model: SiteModel,
  storagePath: string,
  opts: WriteCrawlOptions = {},
): Promise<{ storage: SQLiteStorage } & WriteCrawlResult> {
  const baseUrl = opts.baseUrl ?? "http://synthetic.test";
  const now = opts.now ?? deterministicTimestamp(model.seed);
  const storage = new SQLiteStorage(storagePath);

  // On success, `storage` is returned OPEN for the caller to query/close
  // (required for `:memory:`, see the doc comment above). On a thrown error
  // partway through — INCLUDING init() itself failing on a real file path
  // (bad permissions, disk full, etc.) — nobody else holds a reference to
  // close it. `storage.close()` is a safe no-op if `init()` never got as far
  // as opening a `Database` handle, so best-effort close covers both cases
  // before rethrowing (avoids leaving a locked/partial SQLite file behind
  // for a real `--write-db <path>`).
  try {
    await run(storage.init());
    return await writeCrawlBody(model, storage, baseUrl, now, opts);
  } catch (err) {
    await run(storage.close()).catch(() => {});
    throw err;
  }
}

async function writeCrawlBody(
  model: SiteModel,
  storage: SQLiteStorage,
  baseUrl: string,
  now: number,
  opts: WriteCrawlOptions,
): Promise<{ storage: SQLiteStorage } & WriteCrawlResult> {
  const crawlId = await run(
    storage.createCrawl({
      baseUrl,
      seedUrl: baseUrl,
      originalUrl: baseUrl,
      startedAt: now,
      status: "running",
      config: {
        maxPages: model.pages.length,
        concurrency: 1,
        perHostConcurrency: 1,
        delayMs: 0,
        perHostDelayMs: 0,
        timeoutMs: 30_000,
        userAgent: "synthetic-site",
        followRedirects: true,
        respectRobots: false,
        incremental: false,
        include: [],
        exclude: [],
        allowQueryParams: [],
        dropQueryPrefixes: [],
        allowedDomains: [],
      },
      stats: {
        pagesTotal: 0,
        pagesFetched: 0,
        pagesFailed: 0,
        pagesSkipped: 0,
        pagesUnchanged: 0,
        linksTotal: 0,
        imagesTotal: 0,
        bytesTotal: 0,
        avgLoadTimeMs: 0,
      },
    }),
  );

  const depthByPath = computeDepths(model);
  const fetchedAt = now;
  const batchSize = effectiveBatchSize(
    Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE),
    model.options.maxPageSizeBytes,
  );
  const baseHostname = new URL(baseUrl).hostname;

  let bytesTotal = 0;
  let linksTotal = 0;
  let linkAppearanceCount = 0;

  for (let start = 0; start < model.pages.length; start += batchSize) {
    const batch = model.pages.slice(start, start + batchSize);

    // Render/shape records for this batch only — nothing beyond one batch's
    // worth of pages is ever held at once, keeping peak memory bounded at 25k.
    const prepared = batch.map((page) => {
      const isRedirect = page.statusCode >= 300 && page.statusCode < 400;
      const html = isRedirect ? null : renderPageHtml(page, baseUrl);
      const sizeBytes = html ? Buffer.byteLength(html, "utf8") : 0;
      const pageUrl = `${baseUrl}${page.path}`;
      // For an intermediate hop this is the NEXT hop's URL, not the chain's
      // ultimate destination — matches how each hop record's `redirectTo`
      // is one link in the chain (page-model.ts's applyRedirectChains).
      // Consumers that want the final landing page should walk `redirectTo`
      // hop-by-hop rather than reading a single hop's `finalUrl`.
      const finalUrl = isRedirect && page.redirectTo ? `${baseUrl}${page.redirectTo}` : pageUrl;
      // Faithfully mirror the real crawler's write path (crawler.ts:938-973):
      // HTML pages store `parsedData` = JSON of parsePage(body, finalUrl) minus
      // the (non-serializable) document. Rules re-hydrate this via
      // buildSiteContext's parsedData branch, and createSiteQuery reads
      // parsedData.links for the internal link graph — both false-diverge from a
      // real crawl DB when this is null. Parsed with `finalUrl` and the document
      // dropped immediately (only the JSON string is retained), so peak memory
      // stays bounded to one live DOM at a time even at 25k scale.
      let parsedData: string | null = null;
      if (html !== null) {
        const { document: _doc, ...serializableParsed } = parsePage(html, finalUrl);
        parsedData = JSON.stringify(serializableParsed);
      }
      const record: PageRecord = {
        url: pageUrl,
        normalizedUrl: pageUrl,
        finalUrl,
        depth: depthByPath.get(page.path) ?? 0,
        status: page.statusCode,
        contentType: html ? "text/html" : null,
        sizeBytes,
        loadTimeMs: 1,
        fetchedAt,
        etag: null,
        lastModified: null,
        contentHash: hashStringHex(html ?? page.path),
        html,
        parsedData,
        headers: EMPTY_HEADERS,
        securityHeaders: EMPTY_SECURITY_HEADERS,
      };
      // Mirrors the real crawler's convention: `link_appearances` holds ONLY
      // external link occurrences (apps/cli/src/audit/adapter.ts's only
      // production call site of addLinkAppearancesBatch is inside the
      // external-link-checking block). Internal links are never written
      // here in a real crawl — they're derived from parsed HTML at rule-run
      // time, which this writer already provides via `record.html` above.
      // A synthetic model that wrote internal rows here would silently
      // diverge from what a real crawl DB looks like — the exact ground-
      // truth mismatch this direct-storage mode exists to avoid.
      const appearances: LinkAppearanceRecord[] = page.outgoingLinks
        .filter((href) => isExternalHref(href, baseUrl, baseHostname))
        .map((href) => ({
          href: absoluteHref(href, baseUrl),
          pageUrl,
          anchorText: linkText(href),
          position: "content",
          isNofollow: false,
        }));
      return { sizeBytes, record, appearances };
    });

    await run(
      storage.transaction(() => {
        for (const { record, appearances } of prepared) {
          runSync(storage.upsertPage(crawlId, record));
          if (appearances.length > 0) {
            runSync(storage.addLinkAppearancesBatch(crawlId, appearances));
          }
        }
      }),
    );

    for (const { sizeBytes, appearances } of prepared) {
      bytesTotal += sizeBytes;
      linksTotal += appearances.length;
      linkAppearanceCount += appearances.length;
    }
  }

  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  const robotsBody = buildRobotsTxt(baseUrl);
  await run(
    storage.setRobotsTxt(crawlId, {
      url: `${baseUrl}/robots.txt`,
      exists: true,
      content: robotsBody,
      sizeBytes: Buffer.byteLength(robotsBody, "utf8"),
      sitemaps: [sitemapUrl],
      fetchedAt,
    }),
  );
  await run(
    storage.addSitemap(crawlId, {
      url: sitemapUrl,
      type: "urlset",
      urlCount: model.sitemapPaths.length,
      childSitemaps: [],
      errors: [],
      fetchedAt,
    }),
  );
  await run(
    storage.addSitemapUrls(
      crawlId,
      model.sitemapPaths.map((path) => ({ sitemapUrl, loc: `${baseUrl}${path}` })),
    ),
  );

  await run(
    storage.updateStats(crawlId, {
      pagesTotal: model.pages.length,
      pagesFetched: model.pages.length,
      pagesFailed: 0,
      pagesSkipped: 0,
      pagesUnchanged: 0,
      linksTotal,
      imagesTotal: 0,
      bytesTotal,
      avgLoadTimeMs: 1,
    }),
  );
  await run(
    storage.updateCrawl(crawlId, {
      status: opts.crawlStatus ?? "crawled",
      completedAt: now,
    }),
  );

  return { storage, crawlId, pageCount: model.pages.length, linkAppearanceCount };
}
