// Streaming rules engine (#1021, PR-E) — the batched page-rule pass that keeps
// DOM residency bounded to one batch instead of holding every parsed page
// resident. This is the core seam of the streaming architecture; the full
// `runStreamingRules` (site-fetch phase + site pass + RuleExecutionResult
// assembly) is built on top of it.
//
// Dark: nothing wires this into a production audit path yet. v1 (runRulesOnStorage)
// is untouched; v2 is flag-gated and golden-diff-gated (blueprint §5).
//
// Page rules are per-page independent (verified: no page rule reads other pages —
// the 8 touching ctx.site read only scripts/resourceSizes/siteMetadata), so
// streaming them with `siteData.pages: []` is byte-identical to v1's resident
// loop. Per-page results are folded into per-rule tallies via the proven-equal
// foldRuleResultIntoTallies, so the growing O(pages) accumulation that drives v1's
// superlinear per-batch wall-time is avoided.

import { Effect } from "effect";

import type { PageRecord } from "@squirrelscan/core-contracts";
import type { SQLiteStorage } from "@squirrelscan/crawler";
import type { RuleRunResult, SiteData, PageData, ParsedPage } from "@squirrelscan/rules";
import type { RuleRunner } from "@squirrelscan/rules";
import { mergeRuleRunResult } from "@squirrelscan/rules";

import { buildSiteContext, buildHeadersMap, isRenderedFetch } from "./adapter";
import { extractPageFeatures, isAuditablePage } from "./page-features";
import { foldRuleResultIntoTallies, type RuleTally } from "./scoring";

/** Default page batch — bounds DOM residency to ≤ this many live docs at once. */
export const STREAM_PAGE_BATCH = 200;

/**
 * A per-page collector invoked with the LIVE parsed page during the stream, right
 * next to extractPageFeatures. E-E ships zero registered collectors; E-E2 registers
 * one per DOM-scanning site rule (leaked-secrets, total-byte-weight,
 * template-discontinuity, orphan-page, adblock, subprocessor-disclosure) so their
 * per-page signal is captured with the DOM live and the site pass no longer needs
 * to re-materialize DOMs. The collector MUST NOT retain the DOM past its call.
 */
export interface PageSignalCollector {
  readonly id: string;
  collect(page: PageRecord, parsed: ParsedPage): void;
}

export interface StreamPageRulesHooks {
  /** Emitted after each batch with cumulative page count + wall-time, for the flatness gate. */
  onBatch?: (info: { batchIndex: number; pagesDone: number; batchMs: number }) => void;
}

export interface StreamPageRulesResult {
  /** pageUrl -> flat check list (RuleExecutionResult.pageResults). */
  pageResults: Map<string, CheckResultLike[]>;
  /** pageUrl -> (ruleId -> checks) (RuleExecutionResult.pageRuleResults). */
  pageRuleResults: Map<string, Map<string, CheckResultLike[]>>;
  /**
   * ruleId -> concatenated RuleRunResult across pages (RuleExecutionResult.ruleResultsMap).
   * Built via {@link mergeRuleRunResult} so `runStreamingRules` can assemble a
   * byte-identical RuleExecutionResult for v1 parity. Still O(pages)-resident —
   * the `tallies` above are the bounded PR-F scoring path that replaces it.
   */
  ruleResultsMap: Map<string, RuleRunResult>;
  /** Folded per-rule tallies for page-scope rules (§3). */
  tallies: Map<string, RuleTally>;
  /** URLs of pages page-rules actually ran on (HTML, non-WAF) — the site-pass universe seed. */
  pageUrls: string[];
  /** Max DOMs simultaneously live across the whole stream — the residency assertion. */
  peakLiveDocs: number;
  /** Pages the extractor wrote page_features for (isAuditablePage-gated). */
  extractedCount: number;
}

// Re-used shape; avoids pulling the CheckResult symbol name-collision into scope.
type CheckResultLike = import("@squirrelscan/core-contracts").CheckResult;

/**
 * Stream the page-rule pass over a crawl's pages in batches, folding results into
 * per-rule tallies and populating page_features while each DOM is live. Byte-
 * identical to running v1's page rules over the same pages: `runPageRules` is
 * per-page and the `siteData` handed in carries the same non-`pages` fields v1's
 * page rules read.
 *
 * DOM residency is bounded to one batch: each page's parsed document is dropped
 * immediately after its rules + feature extraction + collectors run. `peakLiveDocs`
 * records the high-water mark for the residency test.
 */
export function streamPageRules(
  storage: SQLiteStorage,
  crawlId: string,
  runner: RuleRunner,
  siteDataForPageRules: SiteData,
  opts?: {
    batchSize?: number;
    collectors?: readonly PageSignalCollector[];
    hooks?: StreamPageRulesHooks;
    soft404Confirmations?: ReadonlyMap<string, ParsedPage["soft404Confirmation"]>;
    signal?: AbortSignal;
  }
): Effect.Effect<StreamPageRulesResult, never, never> {
  return Effect.gen(function* () {
    const batchSize = opts?.batchSize ?? STREAM_PAGE_BATCH;
    const collectors = opts?.collectors ?? [];
    const soft404 = opts?.soft404Confirmations;

    const pageResults = new Map<string, CheckResultLike[]>();
    const pageRuleResults = new Map<string, Map<string, CheckResultLike[]>>();
    const ruleResultsMap = new Map<string, RuleRunResult>();
    const tallies = new Map<string, RuleTally>();
    const pageUrls: string[] = [];
    let peakLiveDocs = 0;
    let extractedCount = 0;
    let pagesDone = 0;
    let batchIndex = 0;

    for (let offset = 0; ; offset += batchSize) {
      opts?.signal?.throwIfAborted();
      // A read failure mid-stream is a HARD error, not end-of-crawl. `orDie` so a
      // transient batch failure crashes the audit loud instead of being swallowed
      // to `[]` and treated as "no more pages" — which would silently truncate the
      // scored page set at an arbitrary offset (matches site-query.ts's paginated
      // read pattern; keeps the error channel `never`).
      const batch = yield* storage.getPages(crawlId, { limit: batchSize, offset }).pipe(Effect.orDie);
      if (batch.length === 0) break;

      const batchStart = Date.now();
      // Parse the whole batch (≤ batchSize DOMs live at the peak here).
      const parsedBatch = yield* buildSiteContext(batch);
      peakLiveDocs = Math.max(peakLiveDocs, parsedBatch.filter((p) => p.parsed?.document).length);

      for (const { page, parsed } of parsedBatch) {
        if (!parsed) continue; // non-HTML / failed parse — v1 skips these too
        // WAF-challenge pages are excluded from page-level scoring (v1 parity).
        if (!isAuditablePage(page)) {
          parsed.document = null;
          continue;
        }

        // Thread the pre-computed soft-404 confirmation the way v1's confirm pass
        // mutates parsed before page rules run.
        const confirmation = soft404?.get(page.normalizedUrl);
        if (confirmation !== undefined) parsed.soft404Confirmation = confirmation;

        const pageData: PageData = {
          url: page.url,
          html: page.html!,
          statusCode: page.status,
          loadTime: page.loadTimeMs,
          ttfb: page.ttfb,
          downloadTime: page.downloadTime,
          headers: buildHeadersMap(page),
          parsed,
          finalUrl: page.finalUrl,
          redirectChain: page.redirectChain,
          rendered: isRenderedFetch(page.fetcherId),
        };

        const result = yield* Effect.promise(() =>
          runner.runPageRules(pageData, siteDataForPageRules)
        );

        const pageUrl = page.normalizedUrl;
        pageResults.set(pageUrl, result.checks);
        const ruleChecksForPage = new Map<string, CheckResultLike[]>();
        for (const [ruleId, rr] of result.ruleResults) {
          ruleChecksForPage.set(ruleId, rr.checks);
        }
        pageRuleResults.set(pageUrl, ruleChecksForPage);
        for (const [ruleId, rr] of result.ruleResults) {
          for (const check of rr.checks) if (!check.pageUrl) check.pageUrl = pageUrl;
          // Stamp the page URL FIRST, then both accumulate (v1 parity) and fold
          // (PR-F path) — so ruleResultsMap and tallies see identical checks and
          // stay byte-consistent with each other (mirrors runRulesOnStorage).
          mergeRuleRunResult(ruleResultsMap, ruleId, rr as RuleRunResult);
          foldRuleResultIntoTallies(tallies, ruleId, rr as RuleRunResult);
        }
        pageUrls.push(pageUrl);

        // page_features + E-E2 collectors, DOM still live. The early
        // `!isAuditablePage(page)` continue above already guarantees this page is
        // auditable, so no second gate is needed here.
        yield* storage
          .upsertPageFeatures(crawlId, extractPageFeatures(page, parsed))
          .pipe(Effect.catchAll(() => Effect.void));
        extractedCount++;
        for (const c of collectors) c.collect(page, parsed);

        // Drop this page's DOM before moving on — the residency bound.
        parsed.document = null;
        pagesDone++;
      }

      // Defensive backstop: every path in the per-page loop above already nulls
      // `parsed.document`, so this is a no-op today — but re-nulling the whole batch
      // guarantees a future early-continue that skips the explicit drop still can't
      // leak a live DOM past the batch boundary (the residency invariant).
      for (const { parsed } of parsedBatch) if (parsed) parsed.document = null;

      batchIndex++;
      opts?.hooks?.onBatch?.({
        batchIndex,
        pagesDone,
        batchMs: Date.now() - batchStart,
      });

      if (batch.length < batchSize) break;
    }

    return {
      pageResults,
      pageRuleResults,
      ruleResultsMap,
      tallies,
      pageUrls,
      peakLiveDocs,
      extractedCount,
    };
  });
}
