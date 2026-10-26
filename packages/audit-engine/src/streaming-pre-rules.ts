// Streamed pre-rules phase (#1860) — the half of a cloud audit that sits between
// the crawl and `runStreamingRules`.
//
// `runStreamingRules` already bounds the RULES phase to one batch of live DOMs,
// but wiring it into `runCloudAudit` alone would not have bounded anything: the
// runtime built ONE `buildSiteContext` over every crawled page and handed that
// same resident array, DOMs and all, to the external-link check, the resource
// asset pass and the cloud prefetch. Three of the four consumers genuinely need
// a parsed document per page (link position, stylesheet/script srcs, blocklist
// srcs + selectors), so the DOMs stayed live from the end of the crawl until the
// prefetch released them — the 2.2 GB of linkedom that OOM-killed a 500-page
// audit of ~1 MB pages (#1862).
//
// This runs those consumers' COLLECTION halves together in one batched walk of
// the pages table: parse a batch, absorb it into every collector while its DOMs
// are live, drop the batch, repeat. What each collector retains is bounded by
// the site's distinct sub-resource URLs and by explicit payload caps, never by
// page count × page size. The network halves (link checking, asset fetching) then
// run once over the collected occurrences, exactly as before.
//
// Parity: every collector here is the SAME code the whole-array entry point runs
// (`fetchResourceAssets`, `checkExternalLinksOnStorage`,
// `runContainerCloudPrefetch` all delegate into these accumulators), so there is
// no second implementation to drift. `tests/streaming-pre-rules-golden.test.ts`
// pins that by running both paths over one crawl and deep-comparing the outputs.

import { Effect } from "effect";

import type { ExternalLinksConfig, Config } from "@squirrelscan/config";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { externalLinkCheckCap } from "@squirrelscan/core-contracts/limits";
import type { SQLiteStorage } from "@squirrelscan/crawler";

import {
  absorbExternalLinkOccurrences,
  buildSiteContext,
  checkCollectedExternalLinks,
  createSiteAssetCollector,
  fetchAssetsFromOccurrences,
  releaseSiteContextDocuments,
  type ExternalLinkCheckLimits,
  type ExternalLinkCheckProgress,
  type ExternalLinkOccurrences,
  type PreFetchedAssets,
  type ResourceCheckOverrides,
  type SiteContextPage,
} from "./adapter";
import { ownSiteHostMatcher } from "@squirrelscan/utils/own-site";

import { collectDroppedBatch } from "./batch-gc";
import { createCloudPrefetchCollector, type CloudPrefetchPayloadSet } from "./cloud-prefetch-run";
import type { ExternalCheckResult, LinkCache } from "./external-checker";

/** Default page batch for the pre-rules walk. Smaller than STREAM_PAGE_BATCH
 * because this is the pass whose peak is `batchSize` live DOMs of the site's
 * heaviest pages, and the cloud sizes it from the container's memory ceiling. */
export const PRE_RULES_PAGE_BATCH = 50;

export interface StreamPreRulesOptions {
  batchSize?: number;
  resourceOverrides?: ResourceCheckOverrides;
  /**
   * External-link checking. Omit (or pass a config with `enabled: false`) to skip
   * it — the collection loop then does not gather occurrences at all, which is
   * the only part of this pass that is not otherwise free.
   */
  externalLinks?: {
    config: ExternalLinksConfig;
    onProgress?: (progress: ExternalLinkCheckProgress) => void;
    linkCache?: LinkCache | null;
    bulkChecker?: (urls: string[]) => Promise<Map<string, ExternalCheckResult>>;
    /**
     * Resolve the bulk checker after the collection walk and BEFORE any link is
     * checked (#1913). The CLI gates its paid dead-links checker on a spend
     * confirmation sized from the crawl's external-link count — a number the
     * resident path had up front from a whole-crawl site context and this pass
     * only has once the walk ends. Deferring to the first bulk call instead
     * would put the prompt in the middle of the link-check progress output.
     * Ignored when `bulkChecker` is supplied; its rejection is fatal, exactly
     * as an unhandled throw from building the checker would have been.
     */
    resolveBulkChecker?: () => Promise<
      ((urls: string[]) => Promise<Map<string, ExternalCheckResult>>) | undefined
    >;
    /**
     * Links to check ahead of the per-audit limit's most-linked order
     * (repo#2729): the cloud passes the ones an open broken-link finding names,
     * so a capped run still re-checks them and can tell they were fixed.
     */
    priorityHrefs?: readonly string[];
    /**
     * How long the check may take (repo#2613): a wall-clock budget, past which
     * the links not yet reached are reported as not checked, and the longest
     * one call is waited on. Unset: no limit. `onProgress` is called as the
     * check goes, not only when it ends, so a watchdog sees it working.
     */
    limits?: ExternalLinkCheckLimits;
  };
  /**
   * Site URL to collect cloud-prefetch payloads for. Omit when the run has no
   * cloud client, so no payload work is done.
   */
  cloudPrefetchSiteUrl?: string;
  /**
   * Base URL seeded into the threat-intel candidate URLs, matching
   * `collectIntelUrls(siteContext, baseUrl)`. Omit to seed nothing.
   */
  intelBaseUrl?: string;
  /** Fired after each page batch with the running count — the container's
   * liveness heartbeat, so a long pre-rules pass is never silent. */
  onBatch?: (info: { pagesDone: number }) => void;
  /**
   * Per-batch collector seam (#1913). Called with the batch's site context after
   * this pass's own collectors have absorbed it and while its DOMs are still
   * LIVE, so a caller with its own page-time signal to gather (the CLI's cloud
   * prefetch payloads, its bounded tech-detect sample, its smart-audit page
   * list) can do it inside this walk instead of holding a whole-crawl site
   * context of its own — which is the residency term this pass exists to remove.
   *
   * The callee MUST NOT retain anything reachable from the batch's documents or
   * html beyond a bounded sample: the batch is released immediately after this
   * returns, and a retained reference re-links the page-count-scaled term. A
   * string sliced out of a page's html pins that page's whole backing store
   * (#240), so detach what you keep.
   */
  onBatchContext?: (siteContext: SiteContextPage[]) => void;
}

export interface StreamPreRulesResult {
  assets: PreFetchedAssets;
  /** Empty when external-link checking is off, exactly as v1 returns. */
  externalLinkResults: ExternalCheckResult[];
  /**
   * The crawl's FIRST stored page (normalized_url ASC) — v1's `pages[0]`, which
   * the cloud runtime feeds to tech detection. Retained whole (one PageRecord,
   * so one page's html) because tech detect reads its url, html and headers.
   * Null for a crawl with no pages.
   */
  techDetectPage: PageRecord | null;
  /** `collectIntelUrls` order: base URL first, then each page's url + finalUrl. */
  intelUrls: string[];
  /** Null when `cloudPrefetchSiteUrl` was not supplied. */
  cloudPrefetchPayloads: CloudPrefetchPayloadSet | null;
  /** Pages walked — v1's `pages.length`. */
  pageCount: number;
}

/**
 * Run the pre-rules phase over a crawl's stored pages with DOM residency bounded
 * to one batch. See the module header for why this exists and what guarantees
 * parity with the resident path.
 */
export function runStreamingPreRules(
  storage: SQLiteStorage,
  crawlId: string,
  config: Config,
  options?: StreamPreRulesOptions,
): Effect.Effect<StreamPreRulesResult, never, never> {
  return Effect.gen(function* () {
    // Math.max, not `??` alone: `??` lets a 0 through, and SQLite reads
    // `LIMIT 0` as no limit (sqlite.ts guards with `if (options?.limit)`), so a
    // zero batch would return the WHOLE table every iteration while `offset +=
    // 0` never advanced — an infinite loop that re-absorbs the crawl forever.
    const batchSize = Math.max(1, options?.batchSize ?? PRE_RULES_PAGE_BATCH);
    const crawl = yield* storage
      .getCrawl(crawlId)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    const baseUrl = crawl?.baseUrl ?? "";

    // #819: an offline audit reads a reference on the `www` or apex twin or on a
    // `[project] domains` host as the site's own, as sitemap URLs already are.
    const assetCollector = createSiteAssetCollector(
      baseUrl,
      options?.resourceOverrides?.ownSiteOnly === true
        ? ownSiteHostMatcher({ baseUrl, domains: config.project?.domains })
        : undefined,
    );
    const externalLinksEnabled = options?.externalLinks?.config.enabled === true;
    const externalLinkOccurrences: ExternalLinkOccurrences = new Map();
    const prefetchCollector = options?.cloudPrefetchSiteUrl
      ? createCloudPrefetchCollector(options.cloudPrefetchSiteUrl)
      : null;

    // Seeded and ordered exactly as collectIntelUrls does. Threat-intel is opt-in
    // and off by default, so the caller omits `intelBaseUrl` when it is off and
    // the per-page accumulation below is skipped entirely.
    const collectIntelUrls = options?.intelBaseUrl !== undefined;
    const intelUrlSet = new Set<string>();
    if (options?.intelBaseUrl) intelUrlSet.add(options.intelBaseUrl);

    let techDetectPage: PageRecord | null = null;
    let pageCount = 0;

    for (let offset = 0; ; offset += batchSize) {
      // Fail-loud: a mid-walk read failure must not read as end-of-crawl and
      // silently shrink the asset/link/payload universe (matches streamPageRules).
      const batch = yield* storage
        .getPages(crawlId, { limit: batchSize, offset })
        .pipe(Effect.orDie);
      if (batch.length === 0) break;

      // `getPages` orders by normalized_url ASC, so the first row of the first
      // batch is v1's `pages[0]`.
      if (techDetectPage === null) techDetectPage = batch[0] ?? null;
      pageCount += batch.length;

      // Only when a base URL was supplied, i.e. the caller actually wants intel
      // candidates; otherwise this is two Set writes per page for nothing.
      if (collectIntelUrls) {
        for (const page of batch) {
          if (page.url) intelUrlSet.add(page.url);
          if (page.finalUrl) intelUrlSet.add(page.finalUrl);
        }
      }

      const ctx = yield* buildSiteContext(batch);
      // Every absorb below runs with this batch's DOMs live; the batch is dropped
      // immediately after, which is the whole residency bound.
      assetCollector.absorb(ctx);
      if (externalLinksEnabled) absorbExternalLinkOccurrences(externalLinkOccurrences, ctx);
      prefetchCollector?.absorb(ctx);
      // Caller-owned collectors run last, still inside the live-DOM window.
      options?.onBatchContext?.(ctx);
      releaseSiteContextDocuments(ctx);
      // Dropped is not collected — see batch-gc.ts. Without this the walk's peak
      // is set by how far behind the collector happens to be, not by batchSize.
      collectDroppedBatch();

      options?.onBatch?.({ pagesDone: pageCount });
      if (batch.length < batchSize) break;
    }

    // Network halves, in v1's order: external links are checked and PERSISTED
    // first because `buildStreamingSiteData` later reads the link + appearance
    // rows they write.
    const bulkChecker = options?.externalLinks
      ? (options.externalLinks.bulkChecker ??
        (options.externalLinks.resolveBulkChecker
          ? yield* Effect.promise(options.externalLinks.resolveBulkChecker)
          : undefined))
      : undefined;
    const externalLinkResults = options?.externalLinks
      ? yield* checkCollectedExternalLinks(
          storage,
          crawlId,
          externalLinkOccurrences,
          // repo#2729: an explicit `max_links` wins; unset is the audit's page
          // budget, so the cloud's one-credit-per-page reservation is an upper bound.
          {
            ...options.externalLinks.config,
            max_links:
              options.externalLinks.config.max_links ??
              externalLinkCheckCap(config.crawler?.max_pages ?? 0),
          },
          options.externalLinks.onProgress,
          options.externalLinks.linkCache ?? null,
          bulkChecker,
          options.externalLinks.priorityHrefs,
          options.resourceOverrides?.egressPinnedByTransport,
          options.externalLinks.limits,
        )
      : [];

    const assets = yield* fetchAssetsFromOccurrences(
      storage,
      crawlId,
      assetCollector.occurrences,
      config,
      options?.resourceOverrides,
    );

    return {
      assets,
      externalLinkResults,
      techDetectPage,
      intelUrls: [...intelUrlSet],
      cloudPrefetchPayloads: prefetchCollector ? prefetchCollector.build() : null,
      pageCount,
    };
  });
}
