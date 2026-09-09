// Streaming rules engine (#1021, PR-E) — the batched page-rule pass that keeps
// DOM residency bounded to one batch instead of holding every parsed page
// resident. This is the core seam of the streaming architecture; the full
// `runStreamingRules` (site-fetch phase + site pass + RuleExecutionResult
// assembly) is built on top of it.
//
// No longer dark: the CLOUD audit path runs on this as of #1860 and the CLI as of
// #1913. `runRulesOnStorage` (v1) is still the reference the golden diffs compare
// against (blueprint §5) — and note those gates only cover cases their fixtures
// contain. #1829's rate-limited-page handling landed after they were written and
// diverged here unnoticed until #1860.
//
// Page rules are per-page independent (verified: no page rule reads other pages —
// the 8 touching ctx.site read only scripts/resourceSizes/siteMetadata), so
// streaming them with `siteData.pages: []` is byte-identical to v1's resident
// loop. Per-page results are folded into per-rule tallies via the proven-equal
// foldRuleResultIntoTallies, so the growing O(pages) accumulation that drives v1's
// superlinear per-batch wall-time is avoided.
//
// TEMPLATE FAN-OUT (#1951) rides on that independence: a rule declaring
// `verdictScope: "template"` runs once per template cluster and its verdict is
// copied onto the cluster's other members. It is ON here and only here — v1 has no
// cluster key and is left alone — with `SQUIRREL_TEMPLATE_FANOUT=0` as the kill
// switch. See template-fanout.ts for what makes it sound and what it can never do.

import { Effect } from "effect";

import type { PageRecord } from "@squirrelscan/core-contracts";
import type { SQLiteStorage } from "@squirrelscan/crawler";
import type { PageFingerprint, RuleRunResult, SiteData, PageData, ParsedPage } from "@squirrelscan/rules";
import type { RuleRunner } from "@squirrelscan/rules";
import { fingerprintPage, mergeRuleRunResult } from "@squirrelscan/rules";

import { buildSiteContext, buildHeadersMap, isRenderedFetch } from "./adapter";
import { collectDroppedBatch } from "./batch-gc";
import { detachFromPage } from "./detach";
import { extractPageFeatures, isAuditablePage } from "./page-features";
import type { PageRuleLoopHooks } from "./page-rule-executor";
import {
  emptyRuleCacheStats,
  type PageRuleCacheEntry,
  type RuleCacheStats,
  type StreamRuleCache,
} from "./rule-cache";
import { foldRuleResultIntoTallies, type RuleTally } from "./scoring";
import { templateFingerprintKey } from "./template-key";
import {
  createTemplateFanout,
  fanoutClusterKey,
  templateFanoutEnabled,
  type TemplateFanoutStats,
} from "./template-fanout";

/** Default page batch — bounds DOM residency to ≤ this many live docs at once. */
export const STREAM_PAGE_BATCH = 200;

/**
 * Per-page values the loop computed for `page_features` and hands to collectors so
 * they are built ONCE per page rather than once per consumer (#1949).
 */
export interface SharedPageSignals {
  /**
   * `fingerprintPage(parsed, normalizedUrl)` — five `querySelectorAll` passes over
   * the live DOM. Both `page_features.template_fp` (as an equality key) and the
   * collected signal `template-discontinuity` aggregates (as a fuzzy comparand)
   * need it, and computing it twice would put a second per-page DOM walk back into
   * the pipeline #1913 exists to keep flat. `null` when the page has no document.
   */
  readonly fingerprint: PageFingerprint | null;
}

/**
 * A per-page collector invoked with the LIVE parsed page during the stream, right
 * next to extractPageFeatures. E-E ships zero registered collectors; E-E2 registers
 * one per DOM-scanning site rule (leaked-secrets, total-byte-weight,
 * template-discontinuity, orphan-page, adblock, subprocessor-disclosure) so their
 * per-page signal is captured with the DOM live and the site pass no longer needs
 * to re-materialize DOMs. The collector MUST NOT retain the DOM past its call, and
 * must not retain `shared` either — its fingerprint holds page-HTML slices, so a
 * collector that keeps it keeps the page (#1860); `detachFromPage` first.
 */
export interface PageSignalCollector {
  readonly id: string;
  /**
   * Returns the value this page contributed, so the rule-result cache (#1990) can
   * store it and {@link PageSignalCollector.replay} can re-contribute it on a
   * later run without the DOM. Return `undefined` to say "not cacheable" — a
   * collector that does blocks replay for every page, which is the safe default
   * for one whose contribution cannot be reproduced from data alone.
   */
  collect(page: PageRecord, parsed: ParsedPage, shared: SharedPageSignals): unknown;
  /**
   * Re-contribute a snapshot a previous run's `collect` returned, at the same
   * point in the stream, so the collected order is the crawl order either way.
   * Absent => this collector cannot replay, and no page is replayed while it is
   * registered.
   */
  replay?(page: PageRecord, snapshot: unknown): void;
}

export interface StreamPageRulesHooks {
  /** Emitted after each batch with cumulative page count + wall-time, for the flatness gate. */
  onBatch?: (info: { batchIndex: number; pagesDone: number; batchMs: number }) => void;
}

/** Yield to a macrotask so timers/heartbeats queued during sync work can fire. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
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
  /**
   * What the template fan-out actually did (#1951). All zeros when it is off, and
   * `fannedRuleRuns` is the number of page-rule invocations it removed — the only
   * measure that distinguishes a working fan-out from one whose byte-identical
   * output it produced by running everything anyway.
   */
  templateFanout: TemplateFanoutStats;
  /**
   * What the per-page rule-result cache did (#1990). All zeros when no cache was
   * supplied. `replayedPages` is the number of pages that were never parsed and
   * whose rules never ran — the measure that distinguishes a working cache from
   * one whose byte-identical output it produced by running everything anyway.
   */
  ruleCache: RuleCacheStats;
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
    /**
     * The page-rule universe as normalized URLs — v1's `pageDataMap` key set.
     * When supplied, ONLY these pages run, which is what keeps the streamed pass
     * on exactly v1's set instead of re-deriving it from a second predicate that
     * can drift. It already had: `isAuditablePage` excludes non-HTML and WAF
     * challenge pages but NOT rate-limited ones (#1829 landed after #1021), so
     * without this a stored 429/430 page was scored here and skipped by v1, and
     * its page_features row polluted the siteQuery rollups. `runStreamingRules`
     * always passes it; the per-rule golden fixtures (all HTML 2xx) omit it and
     * fall back to the `isAuditablePage` gate, for which the two agree.
     */
    pageUniverse?: ReadonlySet<string>;
    /**
     * #1252 cooperative-yield + heartbeat hooks, the same ones v1's
     * {@link SerialPageRuleExecutor} takes. The cloud MUST pass them: page rules
     * are sync CPU, and without a macrotask yield the single thread never returns
     * to the timers phase, so the rules deadline, the post-crawl backstop AND the
     * container's 30s liveness heartbeat all starve and the stale reaper kills a
     * healthy-but-slow run (#1251). Omitted → byte-identical local behavior.
     */
    pageLoopHooks?: PageRuleLoopHooks;
    /**
     * Total pages the loop expects to run, for the heartbeat's `(done, total)`.
     * v1 reports `tasks.length` (its page-rule universe size); pass the same
     * number — the universe set's size — so a progress marker means the same
     * thing on both paths. Unset → the running done count is reported as total.
     */
    totalPages?: number;
    /**
     * Template fan-out (#1951): run each rule declaring `verdictScope: "template"`
     * once per template cluster and give its verdict to the cluster's other
     * members. Defaults to {@link templateFanoutEnabled} — ON, with
     * `SQUIRREL_TEMPLATE_FANOUT=0` as the kill switch. Pass `false` to compare
     * against the ordinary path; the two must produce byte-identical results,
     * which is what `template-fanout-equivalence-golden.test.ts` asserts.
     */
    templateFanout?: boolean;
    /** Test/bench seam: cap the cached clusters (see DEFAULT_MAX_CLUSTERS). */
    templateFanoutMaxClusters?: number;
    /**
     * Per-page rule-result cache (#1990). Supplied → a page whose key matches a
     * stored entry is NOT parsed and its rules do NOT run; its stored verdicts,
     * `page_features` row and collector signals are replayed in its place, and
     * every page's entry (replayed ones included) is handed back for this crawl to
     * store. Omitted → every page runs, byte-identically to before.
     */
    ruleCache?: StreamRuleCache;
  }
): Effect.Effect<StreamPageRulesResult, never, never> {
  return Effect.gen(function* () {
    // Clamped: a 0 batch means `LIMIT 0` (no limit in SQLite) plus `offset += 0`,
    // i.e. an infinite loop over the whole crawl. See streaming-pre-rules.ts.
    const batchSize = Math.max(1, opts?.batchSize ?? STREAM_PAGE_BATCH);
    const collectors = opts?.collectors ?? [];
    const soft404 = opts?.soft404Confirmations;
    const universe = opts?.pageUniverse;
    const yieldEveryMs = opts?.pageLoopHooks?.yieldEveryMs;
    const heartbeatEvery = Math.max(1, opts?.pageLoopHooks?.heartbeatEveryPages ?? 1);
    const onLoopProgress = opts?.pageLoopHooks?.onProgress;
    let lastYieldAt = Date.now();

    // #1990. A cache is only usable if EVERY registered collector can replay: a
    // page that skipped its parse cannot re-run one that has no `replay`, and
    // silently dropping its contribution would change the site pass's input.
    const ruleCache =
      opts?.ruleCache && collectors.every((c) => typeof c.replay === "function")
        ? opts.ruleCache
        : undefined;
    const ruleCacheStats = emptyRuleCacheStats();

    // TEMPLATE FAN-OUT AND THE RULE CACHE ARE MUTUALLY EXCLUSIVE, and the cache
    // wins (#1990 x #1951). They are two ways of not running a rule, and they do
    // not compose:
    //
    // A fanned verdict is a property of the page's CLUSTER, not of the page, so no
    // per-page key can capture what it depends on. Cache A and B of one cluster,
    // then change A — the cluster's representative. A is fresh and records its new
    // verdict; B replays the OLD verdict it inherited from A's previous run, and a
    // fully-replayed audit after that reports B's stale value forever. A fresh
    // audit of the same content gives B the new one. Keying B on its own inputs
    // cannot see this, because nothing about B changed.
    //
    // Fixing it properly means caching the CLUSTER's verdict against its
    // representative's identity, which is a whole-crawl property the streamed loop
    // resolves as it goes. That is a design, not a patch.
    //
    // The trade this makes: a COLD audit gives up fan-out's 13% of the page-rule
    // pass; every audit after it takes the cache's ~88%. `SQUIRREL_RULE_CACHE=0`
    // gets fan-out back, and the cloud is unaffected — it passes no cache.
    const fanout =
      !ruleCache && (opts?.templateFanout ?? templateFanoutEnabled())
        ? createTemplateFanout(runner, { maxClusters: opts?.templateFanoutMaxClusters })
        : null;

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

      // #1990: decide what can be REPLAYED before anything is parsed — that is the
      // whole saving. Keys are built from the stored page record alone (exact HTML
      // hash + the fields the rules read + the run context), so resolving them
      // costs no DOM, and a hit means this batch never materializes one.
      const replayByUrl = new Map<string, PageRuleCacheEntry>();
      const keyByUrl = new Map<string, string>();
      if (ruleCache) {
        const cache = ruleCache;
        const keys = yield* Effect.promise(async () => {
          const wanted: string[] = [];
          for (const page of batch) {
            // A page outside the universe never ran rules, so it can have no
            // entry; skip the key work rather than looking up a certain miss.
            const inUniverse = universe
              ? universe.has(page.normalizedUrl)
              : isAuditablePage(page);
            if (!inUniverse) continue;
            const key = await cache.keyFor(page, soft404?.get(page.normalizedUrl));
            if (key) {
              keyByUrl.set(page.normalizedUrl, key);
              wanted.push(key);
            }
          }
          return wanted;
        });
        const loaded = yield* Effect.promise(() => cache.load(keys));
        for (const [url, key] of keyByUrl) {
          const entry = loaded.get(key);
          // An entry missing a registered collector's snapshot is a MISS, not a
          // replay with a hole in it: `replay(page, undefined)` would push an
          // undefined signal into the site pass's input and change its answer
          // silently. The engine version in the key already makes this unreachable
          // today, since the collector set is code — this is what keeps it
          // unreachable when it stops being.
          if (!entry) continue;
          if (collectors.every((c) => c.id in entry.signals)) replayByUrl.set(url, entry);
        }
      }

      // Parse only what has to be parsed (≤ batchSize DOMs live at the peak).
      const toParse =
        replayByUrl.size === 0 ? batch : batch.filter((p) => !replayByUrl.has(p.normalizedUrl));
      const parsedBatch = yield* buildSiteContext(toParse);
      peakLiveDocs = Math.max(peakLiveDocs, parsedBatch.filter((p) => p.parsed?.document).length);
      const parsedByUrl = new Map(parsedBatch.map((e) => [e.page.normalizedUrl, e.parsed]));

      for (const page of batch) {
        // Per-page interruption checkpoint, matching SerialPageRuleExecutor's.
        // Checking only per batch would let a `rulesPhaseTimeoutMs` breach run a
        // whole batch of heavy pages to completion before it took effect.
        opts?.signal?.throwIfAborted();

        const replayEntry = replayByUrl.get(page.normalizedUrl);
        if (replayEntry) {
          yield* replayPage(
            page,
            replayEntry,
            runner,
            crawlId,
            storage,
            collectors,
            pageResults,
            pageRuleResults,
            ruleResultsMap,
            tallies,
            pageUrls,
          );
          extractedCount++;
          ruleCacheStats.replayedPages++;
          ruleCache?.carryForward(keyByUrl.get(page.normalizedUrl)!, page);
          ruleCacheStats.storedEntries++;
          pagesDone++;
          if (onLoopProgress && pagesDone % heartbeatEvery === 0) {
            onLoopProgress(pagesDone, opts?.totalPages ?? pagesDone);
          }
          if (yieldEveryMs != null && yieldEveryMs > 0 && Date.now() - lastYieldAt >= yieldEveryMs) {
            yield* Effect.promise(() => yieldToEventLoop());
            lastYieldAt = Date.now();
            opts?.signal?.throwIfAborted();
          }
          continue;
        }

        const parsed = parsedByUrl.get(page.normalizedUrl);
        if (!parsed) continue; // non-HTML / failed parse — v1 skips these too
        // WAF-challenge pages are excluded from page-level scoring (v1 parity).
        // With a `pageUniverse` that set is v1's own, so WAF *and* rate-limited
        // pages are excluded together; without one this falls back to the
        // WAF-only predicate (see the option's doc).
        const inUniverse = universe ? universe.has(page.normalizedUrl) : isAuditablePage(page);
        if (!inUniverse) {
          parsed.document = null;
          continue;
        }

        // Thread the pre-computed soft-404 confirmation the way v1's confirm pass
        // mutates parsed before page rules run.
        const confirmation = soft404?.get(page.normalizedUrl);
        if (confirmation !== undefined) parsed.soft404Confirmation = confirmation;

        const pageUrl = page.normalizedUrl;
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

        // ONE fingerprint per page, three consumers now: `page_features.template_fp`
        // reduces it to an equality cluster key (#1949), the collected signal keeps
        // it whole for `template-discontinuity`'s fuzzy comparison, and the fan-out
        // below groups on the same key. Built here rather than inside any consumer
        // so the loop still walks each DOM exactly once.
        //
        // It moved ABOVE the rule run for #1951 — the cluster has to be known
        // before the rules are dispatched, not after. That is safe because
        // `fingerprintPage` reads only chrome (asset hosts, body classes, CSS
        // custom properties, stylesheet hrefs, nav/footer) and page rules do not
        // mutate the DOM; `template-cluster-key-golden.test.ts` pins the stored
        // keys, so a rule that did would fail there.
        const shared: SharedPageSignals = {
          fingerprint: fingerprintPage(parsed, pageUrl),
        };
        // The grouping key is the template cluster AND this page's origin: a
        // declared rule may resolve resources against the origin (`security/sri`
        // decides "cross-origin" by comparing it), so a crawl spanning http:// and
        // https:// must not copy a verdict across that boundary.
        const clusterKey = fanout
          ? fanoutClusterKey(templateFingerprintKey(shared.fingerprint), pageUrl)
          : null;
        const fanned = fanout?.take(clusterKey);

        const raw = yield* Effect.promise(() =>
          runner.runPageRules(
            pageData,
            siteDataForPageRules,
            fanned ? { fannedRuleChecks: fanned } : undefined
          )
        );

        // Detach the findings from the page before retaining them (#1860). Every
        // string a rule pulled out of this page — a message, an item label, a
        // matched value — is a slice of the page's HTML, and JSC keeps a slice
        // attached to the buffer it came from, so retaining any one of them
        // retains the whole page as UTF-16 for the rest of the run.
        //
        // ONLY the checks graph is cloned. Two things must stay out of it:
        //
        //  - `meta`, which carries the rule's Zod `optionsSchema`. structuredClone
        //    throws on it (20 of 198 page rules), and because ONE failure aborts
        //    the whole clone, including meta made this a silent no-op that the
        //    golden tests could never catch — the findings were unchanged, just
        //    still attached. meta is per-RULE, not per-page, so it retains nothing.
        //  - `parsed`, which the runner returns and nothing here reads. Cloning it
        //    would copy the live document and strip SchemaCollection's methods.
        //
        // One clone for the whole graph, not one per consumer: `pageResults`,
        // `pageRuleResults` and `ruleResultsMap` all reference the SAME check
        // objects, and cloning the container in a single call preserves that
        // sharing. Cloning them separately would triple the findings.
        const byRule = [...raw.ruleResults];
        const detached = detachFromPage(
          {
            checks: raw.checks,
            ruleChecks: byRule.map(([, rr]) => rr.checks),
          },
          "page-rules",
        );
        const result = {
          checks: detached.checks,
          ruleResults: new Map(
            byRule.map(([ruleId, rr], i) => [
              ruleId,
              { ...rr, checks: detached.ruleChecks[i]! },
            ]),
          ),
        };

        // Keep this page's template-scoped verdicts for the rest of its cluster,
        // BEFORE `pageUrl` is stamped below, so what a member inherits is
        // page-identity-free and its own stamp is a first write (#1951). Only when
        // this page ran the rules itself — a member has nothing new to say.
        if (!fanned) fanout?.record(clusterKey, result.ruleResults);

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
        // auditable, so no second gate is needed here. `shared` was built before
        // the rules ran (see above); it is the same object either way.
        const features = extractPageFeatures(page, parsed, shared);
        yield* storage
          .upsertPageFeatures(crawlId, features)
          .pipe(Effect.catchAll(() => Effect.void));
        extractedCount++;
        const signals: Record<string, unknown> = {};
        let signalsCacheable = true;
        for (const c of collectors) {
          const snapshot = c.collect(page, parsed, shared);
          // `undefined` is a collector saying its contribution cannot be
          // reproduced from data; the page is then scored normally and simply
          // never cached, rather than cached with a hole in it.
          if (snapshot === undefined) signalsCacheable = false;
          else signals[c.id] = snapshot;
        }
        ruleCacheStats.freshPages++;
        const cacheKey = keyByUrl.get(pageUrl);
        if (ruleCache && cacheKey && signalsCacheable) {
          // The checks stored are the ones whose `pageUrl` was just stamped, so a
          // replay's own stamping loop is a no-op and the two paths agree. They
          // are the SAME objects the run already retains, so recording them here
          // adds no residency — the implementation is what decides when to
          // serialize them.
          ruleCache.putFresh(cacheKey, page, {
            ruleResults: [...result.ruleResults].map(([ruleId, rr]) => [ruleId, rr.checks] as const),
            features,
            signals,
          });
          ruleCacheStats.storedEntries++;
        }

        // Drop this page's DOM before moving on — the residency bound.
        parsed.document = null;
        pagesDone++;

        // #1252 parity with SerialPageRuleExecutor: heartbeat every N pages, then
        // a cooperative macrotask yield once enough sync time has elapsed, so the
        // rules deadline and the container liveness heartbeat can actually fire.
        // This page's DOM is dropped above; the REST of the batch still holds
        // live documents across the yield, so the residency bound over a yield is
        // the batch, not zero.
        if (onLoopProgress && pagesDone % heartbeatEvery === 0) {
          onLoopProgress(pagesDone, opts?.totalPages ?? pagesDone);
        }
        if (yieldEveryMs != null && yieldEveryMs > 0 && Date.now() - lastYieldAt >= yieldEveryMs) {
          yield* Effect.promise(() => yieldToEventLoop());
          lastYieldAt = Date.now();
          opts?.signal?.throwIfAborted();
        }
      }

      // Defensive backstop: every path in the per-page loop above already nulls
      // `parsed.document`, so this is a no-op today — but re-nulling the whole batch
      // guarantees a future early-continue that skips the explicit drop still can't
      // leak a live DOM past the batch boundary (the residency invariant).
      for (const { parsed } of parsedBatch) if (parsed) parsed.document = null;
      // Collect the batch we just dropped, so peak residency tracks batchSize
      // rather than the collector's timing (see batch-gc.ts).
      collectDroppedBatch();

      // Bound what an implementation that buffers cache writes is holding to one
      // batch of them (#1990).
      if (ruleCache?.flush) yield* Effect.promise(() => ruleCache.flush!());

      batchIndex++;
      opts?.hooks?.onBatch?.({
        batchIndex,
        pagesDone,
        batchMs: Date.now() - batchStart,
      });

      if (batch.length < batchSize) break;
    }

    // Final marker when the last page didn't land on a heartbeat boundary —
    // mirrors SerialPageRuleExecutor's tail so the last progress event a slow
    // cloud run emits is the real total, not the last multiple of N.
    if (onLoopProgress && (pagesDone === 0 || pagesDone % heartbeatEvery !== 0)) {
      onLoopProgress(pagesDone, opts?.totalPages ?? pagesDone);
    }
    if (ruleCache?.flush) yield* Effect.promise(() => ruleCache.flush!());

    return {
      pageResults,
      pageRuleResults,
      ruleResultsMap,
      tallies,
      pageUrls,
      peakLiveDocs,
      extractedCount,
      templateFanout: fanout?.stats() ?? {
        clusters: 0,
        fannedPages: 0,
        fannedRuleRuns: 0,
        pagesOverCap: 0,
      },
      ruleCache: ruleCacheStats,
    };
  });
}

/**
 * Put one page's CACHED rules-phase output back into the stream, in the place the
 * fresh path would have filled (#1990).
 *
 * Everything the fresh path contributes has to be contributed here, in the same
 * order, or the report stops being byte-identical: the flat check list, the
 * per-rule map, the merged `ruleResultsMap`, the folded tallies, the page url in
 * `pageUrls`, the `page_features` row and every collector's per-page signal. The
 * flat list is REBUILT from the per-rule entries rather than stored twice — the
 * runner produces it by concatenating each rule's checks in enabled-rule order,
 * and the stored entries are in that order.
 *
 * `meta` comes from the LIVE registry, never from the cache: a stored copy could
 * drift from the running rules package, and the key already guarantees the version
 * matches. A rule id the runner no longer knows means the entry belongs to a
 * different rule set than the key claims, so the page is left unscored by the
 * caller's standards — which cannot happen, because the rule id list is part of
 * the key.
 */
function replayPage(
  page: PageRecord,
  entry: PageRuleCacheEntry,
  runner: RuleRunner,
  crawlId: string,
  storage: SQLiteStorage,
  collectors: readonly PageSignalCollector[],
  pageResults: Map<string, CheckResultLike[]>,
  pageRuleResults: Map<string, Map<string, CheckResultLike[]>>,
  ruleResultsMap: Map<string, RuleRunResult>,
  tallies: Map<string, RuleTally>,
  pageUrls: string[],
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const pageUrl = page.normalizedUrl;

    // `meta` comes from the LIVE registry, never from the cache.
    const byRule = new Map<string, RuleRunResult>();
    for (const [ruleId, checks] of entry.ruleResults) {
      const meta = runner.getRuleMeta(ruleId);
      if (meta) byRule.set(ruleId, { meta, checks });
    }

    const flat: CheckResultLike[] = [];
    const ruleChecksForPage = new Map<string, CheckResultLike[]>();
    for (const [ruleId, checks] of entry.ruleResults) {
      for (const check of checks) {
        if (!check.pageUrl) check.pageUrl = pageUrl;
        flat.push(check);
      }
      ruleChecksForPage.set(ruleId, checks);
    }
    pageResults.set(pageUrl, flat);
    pageRuleResults.set(pageUrl, ruleChecksForPage);
    for (const [ruleId, rr] of byRule) {
      mergeRuleRunResult(ruleResultsMap, ruleId, rr);
      foldRuleResultIntoTallies(tallies, ruleId, rr);
    }
    pageUrls.push(pageUrl);

    yield* storage
      .upsertPageFeatures(crawlId, entry.features)
      .pipe(Effect.catchAll(() => Effect.void));
    for (const c of collectors) c.replay!(page, entry.signals[c.id]);
  });
}
