// Cloud-render DocumentFetcher — coalesces concurrent per-page render requests
// into batched jobs against the credit-gated cloud proxy
// (POST /v1/services/render → poll GET /v1/services/render/:jobId).
//
// BATCHING (#269): the DocumentFetcher shim is one-page-in/one-response-out, but
// the server accepts up to `renderBatchUrls` urls/job and returns `results[]`.
// Concurrent `fetch()` calls (one per crawler worker) are buffered for a short
// window, submitted as ONE job, and polled by a SINGLE shared loop — collapsing
// N submit+poll cycles into ceil(N/batch). Server-side parallelism is unchanged
// (each url still renders separately), so the plan render-concurrency gate is
// respected: a batch never holds more urls than the crawler had in flight, which
// is itself capped at the plan limit. Results are demuxed back to per-page
// responses BY URL — the server reorders (cache misses before hits) and dedupes,
// so index-matching is wrong.
//
// NEVER-FAIL INVARIANT: the audit must not die mid-crawl because of cloud
// trouble. On a terminal cloud condition (out of credits, auth expired, or
// 3 consecutive 5xx/transport failures) the fetcher flips PERMANENTLY to the
// provided plain-HTTP fallback fetcher (announcing via onFallback once); a
// one-off render failure/timeout falls back for that url only.

import type {
  RenderChargeLine,
  RenderJobResponse,
  RenderResultItem,
} from "@squirrelscan/core-contracts";
import { CREDIT_COSTS } from "@squirrelscan/core-contracts/credits";
import { SERVICE_LIMITS } from "@squirrelscan/core-contracts/limits";
import type { DocumentFetcher, FetchRequest, FetchResponse } from "@squirrelscan/fetchers";

import { CloudClientError, type CloudServicesClient } from "@squirrelscan/cloud-client";
import { detectWafChallengePage, WAF_CHALLENGE_STATUS_CODES } from "@squirrelscan/waf-detect";

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_FIRST_POLL_MS = 300;
// A touch wider than a bare coalesce (#992): after a batch's per-item deliveries
// free crawler workers at staggered times, a slightly longer window re-merges
// their next fetches into fuller batches instead of trickling 1-2-url jobs.
const DEFAULT_BATCH_WINDOW_MS = 25;
const POLL_BACKOFF_FACTOR = 2;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CONSECUTIVE_SERVER_FAILURES = 3;

export interface CloudFetcherOptions {
  /** Plain-HTTP fetcher used per-url on render failure and permanently after fallback. */
  fallback: DocumentFetcher;
  /** Render-result poll interval cap — the backoff ceiling (default 1.5s). */
  pollIntervalMs?: number;
  /** First poll delay before exponential backoff to `pollIntervalMs` (default 300ms). */
  firstPollDelayMs?: number;
  /** Coalescing window: concurrent submits within it share one job (default 10ms). */
  batchWindowMs?: number;
  /** Max urls per batched job (default `SERVICE_LIMITS.renderBatchUrls`). */
  maxBatchUrls?: number;
  /** Per-batch budget: submit + poll until this elapses (default 45s). */
  timeoutMs?: number;
  /** Called ONCE when the fetcher permanently switches to the fallback. */
  onFallback?: (reason: string) => void;
  /**
   * Called when a rendered page was blocked by the headless/CF egress (#490) —
   * 401/403/429 or a WAF/bot-challenge interstitial — and is being retried via
   * the non-browser fallback fetch (local egress). Fires per page, observability
   * only; the page still resolves through the fallback.
   */
  onRenderBlock?: (url: string) => void;
  /**
   * Called after every SUCCESSFUL render submit with the pages submitted in the
   * batch, the actual credits debited (render 2cr / render_cached 1cr per page),
   * and the per-feature debit split (`breakdown`). Charged on submit, so this
   * fires even when a job later fails/times out. Lets the controller account
   * real spend — and split render vs render_cached so cache savings are visible.
   * Older servers omit the split → `breakdown` attributes the whole batch to
   * `render` (the conservative miss assumption). #279
   */
  onRenderCharged?: (units: number, credits: number, breakdown: RenderChargeLine[]) => void;
  /**
   * Shared spend budget (#609). Render is charged ON SUBMIT, so without a
   * preflight a run with under one batch of credit left would still submit a
   * full multi-url batch and overspend the cap. When set, each batch is
   * trimmed to what `cap - spent` (minus in-flight reservations) affords at
   * the worst-case miss cost; over-cap urls settle via the free fallback
   * before submit. The fetcher settles the server's actual debit into `spent`
   * itself — callers passing `budget` must NOT add the `onRenderCharged`
   * amount again.
   */
  budget?: { spent: number; cap: number };
  /**
   * Cloud run id this crawl's renders belong to (#1134). Threaded onto every
   * render submit so the server tags the render debit with `metadata.runId` +
   * `ref_id`, making rendered-page spend attributable per audit in the ledger.
   * Accepts a resolver (read at each submit) for the CLI, whose run registration
   * is async and may land after the fetcher is built — early renders that fire
   * before it resolves stay untagged, the rest are attributed. Optional: absent
   * ⇒ debits land untagged (pre-#1134 behaviour).
   */
  runId?: string | (() => string | undefined);
}

/** A buffered per-page render request awaiting its batch. */
interface Waiter {
  req: FetchRequest;
  resolve: (resp: FetchResponse) => void;
  reject: (err: unknown) => void;
  /** Terminal outcome delivered (resolve/reject done). */
  settled: boolean;
  /**
   * Terminal handling committed — resolved, or the one-and-only fallback fetch
   * started (fallback settles asynchronously, so `settled` lags). Set
   * synchronously so re-sent `completed` items (#992) and overlapping fallback
   * sweeps skip an already-handled waiter instead of double-fetching.
   */
  dispatched: boolean;
  onAbort?: () => void;
}

function abortError(): Error {
  const err = new Error("Cloud render aborted");
  err.name = "AbortError";
  return err;
}

/** Sleep that wakes early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Map a completed RenderResultItem to the DocumentFetcher response shape.
 * Exported for tests. Browser-rendered pages carry their real response headers
 * (lowercase keys) so security rules see actual CSP/HSTS/etc.; only when the
 * item omits headers do we synthesize content-type (downstream parsing gates on it).
 */
export function mapRenderItemToResponse(
  item: RenderResultItem,
  requestUrl: string,
  timing: { startedAt: number; responseAt: number; finishedAt: number },
): FetchResponse {
  const lastHop = item.redirectChain?.[item.redirectChain.length - 1];
  const finalUrl = lastHop?.url ?? item.url ?? requestUrl;
  const status = item.status ?? 0;
  const hops = [
    { url: requestUrl, statusCode: status, type: "http" as const },
    ...(item.redirectChain ?? []).map((hop) => ({
      url: hop.url,
      statusCode: hop.status,
      type: "http" as const,
    })),
  ];
  // Prefer the real render headers (already lowercase from the API); fall back
  // to a synthesized content-type only when the item carries no headers.
  const headers =
    item.headers && Object.keys(item.headers).length > 0
      ? item.headers
      : { "content-type": "text/html; charset=utf-8" };
  return {
    url: requestUrl,
    finalUrl,
    status,
    headers,
    body: item.html ?? "",
    timing,
    redirectChain: {
      sourceUrl: requestUrl,
      finalUrl,
      hops,
      chainLength: Math.max(0, hops.length - 1),
      isLoop: false,
      endsInError: status >= 400,
      httpsToHttp: requestUrl.startsWith("https://") && finalUrl.startsWith("http://"),
      httpToHttps: requestUrl.startsWith("http://") && finalUrl.startsWith("https://"),
    },
    fetcherMethod: "cloud-render",
    // Queue-wait vs render-time breakdown, absent on a render-cache hit (#826).
    renderTimeMs: item.renderTimeMs,
    queueWaitMs: item.queueWaitMs,
  };
}

/**
 * Whether a "successful" render item is actually a block from the headless/CF
 * egress — an active-refusal status (401/403/429) or a WAF/bot-challenge
 * interstitial served as HTML. Such a page should be retried via a non-browser
 * fetch from a different egress (the local user) before being accepted: many
 * sites block headless/CF IPs while serving a plain request fine (#490).
 * Exported for tests.
 */
export function isRenderBlocked(item: RenderResultItem): boolean {
  const status = item.status ?? 0;
  // Active-refusal / unavailable statuses (401/403/429/503) — sourced from the
  // shared set so a 503-with-no-challenge-HTML can't slip past (it wouldn't
  // reach detectWafChallengePage's status check, which gates on interstitial
  // markers first). Stays in sync as the provider list grows.
  if (WAF_CHALLENGE_STATUS_CODES.has(status)) return true;
  return detectWafChallengePage({
    status,
    headers: {
      server: item.headers?.server ?? null,
      cfCacheStatus: item.headers?.["cf-cache-status"] ?? null,
      xCache: item.headers?.["x-cache"] ?? null,
    },
    html: item.html ?? null,
  }).detected;
}

/**
 * Decide whether a cloud error must permanently disable cloud rendering.
 * Exported for tests. Returns the fallback reason, or null to keep trying.
 * `consecutiveServerFailures` INCLUDES the current error.
 */
export function terminalFallbackReason(
  error: unknown,
  consecutiveServerFailures: number,
): string | null {
  if (error instanceof CloudClientError) {
    if (error.code === "insufficient_credits") return "out of credits";
    if (error.code === "not_authenticated") return "not authenticated";
    // The run was reaped/failed mid-crawl (#475) — every further render 409s the
    // same way, so fall back to local HTTP now instead of retrying page by page.
    if (error.code === "run_inactive") return "run no longer active";
    if (
      (error.code === "service_unavailable" || error.code === "network_error") &&
      consecutiveServerFailures >= MAX_CONSECUTIVE_SERVER_FAILURES
    ) {
      return `${consecutiveServerFailures} consecutive cloud failures`;
    }
  }
  return null;
}

function isServerFailure(error: unknown): boolean {
  return (
    error instanceof CloudClientError &&
    (error.code === "service_unavailable" || error.code === "network_error")
  );
}

/** Thrown internally when a render job fails/times out (per-batch fallback). */
class RenderJobError extends Error {}

export function createCloudDocumentFetcher(
  client: CloudServicesClient,
  opts: CloudFetcherOptions,
): DocumentFetcher {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const firstPollDelayMs = Math.min(opts.firstPollDelayMs ?? DEFAULT_FIRST_POLL_MS, pollIntervalMs);
  const batchWindowMs = opts.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const maxBatchUrls = Math.max(1, opts.maxBatchUrls ?? SERVICE_LIMITS.renderBatchUrls);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let fallbackActive = false;
  let consecutiveServerFailures = 0;
  // Worst-case cost of batches submitted but not yet charged — batches process
  // concurrently, so the preflight must see in-flight spend too (#609).
  let reservedCredits = 0;

  // Coalescing buffer + its flush timer.
  const pending: Waiter[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function activateFallback(reason: string): void {
    if (fallbackActive) return;
    fallbackActive = true;
    opts.onFallback?.(reason);
  }

  function detach(w: Waiter): void {
    if (w.onAbort && w.req.signal) {
      w.req.signal.removeEventListener("abort", w.onAbort);
    }
    w.onAbort = undefined;
  }

  function resolveWaiter(w: Waiter, resp: FetchResponse): void {
    if (w.settled) return;
    w.settled = true;
    detach(w);
    w.resolve(resp);
  }

  function rejectWaiter(w: Waiter, err: unknown): void {
    if (w.settled) return;
    w.settled = true;
    detach(w);
    w.reject(err);
  }

  // Claim a waiter for terminal handling exactly once. Returns false if another
  // poll or fallback path already resolved it or started its fallback fetch, so
  // callers skip it — this makes re-sent `completed` items (#992) and overlapping
  // fallback sweeps idempotent (no double-fetch, no double-settle). Synchronous:
  // no await between the check and the set, so within a demux pass it can't race.
  function claim(w: Waiter): boolean {
    if (w.settled || w.dispatched) return false;
    w.dispatched = true;
    return true;
  }

  // Serve a single url via plain HTTP — never lose a page. An aborted request
  // rejects (so its fiber unwinds and releases its host slot) rather than
  // starting a fallback fetch that would just abort too. `fallbackReason` tags
  // why we fell back (e.g. "render-block") so the report can surface it (#512).
  async function fallbackWaiter(w: Waiter, fallbackReason?: string): Promise<void> {
    if (w.settled) return;
    if (w.req.signal?.aborted) {
      rejectWaiter(w, abortError());
      return;
    }
    try {
      const resp = await opts.fallback.fetch(w.req);
      resolveWaiter(w, fallbackReason ? { ...resp, fallbackReason } : resp);
    } catch (err) {
      rejectWaiter(w, err);
    }
  }

  function settleAllViaFallback(waiters: Waiter[]): Promise<void[]> {
    // Claim first: a waiter already resolved (or whose fallback is in-flight) from
    // an earlier per-item delivery (#992) must not get a second fallback fetch.
    return Promise.all(waiters.map((w) => (claim(w) ? fallbackWaiter(w) : Promise.resolve())));
  }

  // Mirror the per-error bookkeeping of the legacy single-url catch: count only
  // transport failures, reset on other (4xx) cloud errors, leave RenderJobError
  // (render-failure/timeout) untouched, and flip to permanent fallback on a
  // terminal condition.
  function classifyCloudError(error: unknown): void {
    if (isServerFailure(error)) {
      consecutiveServerFailures++;
    } else if (!(error instanceof RenderJobError)) {
      consecutiveServerFailures = 0;
    }
    const reason = terminalFallbackReason(error, consecutiveServerFailures);
    if (reason) activateFallback(reason);
  }

  // Demux render items back to per-page responses BY URL — the server
  // reorders/dedupes, so never index-match. Each matched waiter is claimed once,
  // so re-sent items across polls (#992) can't double-settle or double-fall-back.
  // `fallbackUnmatched` controls the no-item branch: a TERMINAL batch (default)
  // falls back for a url absent from `results` (its job is missing/expired); a
  // NON-terminal per-item delivery leaves an unmatched url PENDING for a later
  // poll instead of prematurely falling back.
  function demux(
    results: RenderResultItem[],
    active: Waiter[],
    startedAt: number,
    fallbackUnmatched = true,
  ): void {
    const byUrl = new Map<string, RenderResultItem>();
    for (const item of results) {
      if (item?.url != null) byUrl.set(item.url, item);
    }
    const now = Date.now();
    for (const w of active) {
      const item = byUrl.get(w.req.url);
      if (item === undefined) {
        if (fallbackUnmatched && claim(w)) void fallbackWaiter(w);
        continue;
      }
      if (!claim(w)) continue;
      if (item.error) {
        // Per-url render error (truthy string) → fall back for this url only.
        // `error: null`/absent is not an error and falls through to success.
        void fallbackWaiter(w);
      } else if (isRenderBlocked(item)) {
        // #490: headless/CF egress was blocked (401/403/429/503 or WAF
        // challenge). Retry from the local egress via plain HTTP before
        // accepting it — a direct request often succeeds where the headless
        // render was walled. Checked before the html guard so a bodyless 4xx
        // (WAF closed the connection) still triggers the block path.
        // Observability only — a throwing callback must not discard the page.
        try {
          opts.onRenderBlock?.(w.req.url);
        } catch {
          /* ignore */
        }
        void fallbackWaiter(w, "render-block");
      } else if (item.html !== undefined) {
        resolveWaiter(
          w,
          mapRenderItemToResponse(item, w.req.url, {
            startedAt,
            responseAt: now,
            finishedAt: now,
          }),
        );
      } else {
        // Succeeded but no HTML and not a known block — fall back to be safe.
        void fallbackWaiter(w);
      }
    }
  }

  async function processBatch(waiters: Waiter[]): Promise<void> {
    // Drop requests already aborted before submit — reject (unwind), never
    // charge, never fall back.
    const active: Waiter[] = [];
    for (const w of waiters) {
      if (w.req.signal?.aborted) {
        rejectWaiter(w, abortError());
      } else {
        active.push(w);
      }
    }
    if (active.length === 0) return;

    // Cloud already permanently disabled → serve every url via HTTP, no submit.
    if (fallbackActive) {
      await settleAllViaFallback(active);
      return;
    }

    // Budget preflight (#609): render is charged on submit, so an over-budget
    // batch would debit past the cap before the charge is ever reported. Trim
    // to what the remaining budget affords at worst-case miss cost; trimmed
    // urls settle via the free fallback, matching the other paid ops' gate.
    const budget = opts.budget;
    let reserved = 0;
    if (budget) {
      const perUrl = CREDIT_COSTS.render.cost;
      const affordable = Math.floor(
        Math.max(0, budget.cap - budget.spent - reservedCredits) / perUrl,
      );
      if (affordable < active.length) {
        void settleAllViaFallback(active.splice(affordable));
        if (active.length === 0) return;
      }
      reserved = perUrl * active.length;
      reservedCredits += reserved;
    }

    // A waiter is "retired from the batch" once it's settled OR dispatched (its
    // one-and-only fallback started) OR aborted (rejected → settled). The poll
    // loop exists only to serve still-live waiters, so it must stop the moment
    // EVERY url is retired — not only when all aborted. With per-item early
    // delivery a waiter can settle before its batch finishes; the old
    // all-aborted counter never counted those, so if the remaining urls then
    // aborted it would never reach zero and the detached loop would zombie-poll
    // to the deadline (#992 R-001).
    const allRetired = () => active.every((w) => w.settled || w.dispatched);

    // Shared cancellation: a single url's watchdog rejects just that waiter and
    // keeps the rest of the batch rendering; the cloud job is aborted only once
    // nothing live remains — which wakes a sleeping poll loop to unwind.
    const batchAbort = new AbortController();
    for (const w of active) {
      const onAbort = () => {
        rejectWaiter(w, abortError());
        if (allRetired()) batchAbort.abort();
      };
      w.onAbort = onAbort;
      w.req.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const urls = active.map((w) => w.req.url);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    // Per-page render budget; the server clamps to BROWSER_QUEUE bounds.
    const reqTimeoutMs = Math.max(0, ...active.map((w) => w.req.timeoutMs ?? 0)) || undefined;

    let job: RenderJobResponse;
    try {
      // Resolve the run id at submit time (a CLI resolver may only now have the
      // async-registered id). #1134
      const runId = typeof opts.runId === "function" ? opts.runId() : opts.runId;
      job = await client.render(
        { urls, timeoutMs: reqTimeoutMs, ...(runId ? { runId } : {}) },
        { signal: batchAbort.signal },
      );
    } catch (error) {
      // Nothing was debited — free the preflight reservation.
      reservedCredits -= reserved;
      // batchAbort fires only when EVERY url aborted (caller cancellation) — the
      // resulting transport error is not a cloud failure, so skip classification
      // (mirrors the legacy `if (req.signal.aborted) throw` guard). Waiters are
      // already rejected by their abort listeners.
      if (!batchAbort.signal.aborted) classifyCloudError(error);
      await settleAllViaFallback(active);
      return;
    }
    // Charge-on-submit: the server debited the whole batch. Report total spend
    // (render_cached on hits); older servers omit `charged` → render miss cost.
    const charged = job.charged ?? CREDIT_COSTS.render.cost * urls.length;
    // Swap the worst-case reservation for the server's actual debit — this must
    // land even if the accounting callback below throws (#609).
    reservedCredits -= reserved;
    if (budget) budget.spent += charged;
    // Accounting only — a throwing callback must not discard rendered pages.
    try {
      // Prefer the server's per-feature split; older servers omit it → attribute
      // the whole batch to `render` (every url assumed a miss). #279
      const breakdown: RenderChargeLine[] = job.chargedBreakdown ?? [
        { feature: "render", units: urls.length, credits: charged },
      ];
      opts.onRenderCharged?.(urls.length, charged, breakdown);
    } catch {
      /* ignore */
    }

    // Single shared poll loop with exponential backoff (polling is free, so a
    // short first poll beats the flat interval on fast renders).
    let pollDelay = firstPollDelayMs;
    try {
      while (Date.now() < deadline) {
        if (batchAbort.signal.aborted) throw new RenderJobError("Cloud render aborted");
        await sleep(Math.min(pollDelay, Math.max(1, deadline - Date.now())), batchAbort.signal);
        const result = await client.renderResult(job.jobId, { signal: batchAbort.signal });
        if (result.status === "done") {
          // Full round-trip success → the cloud is healthy; clear the
          // transport-failure streak (only `done` resets, per legacy parity).
          consecutiveServerFailures = 0;
          demux(result.results ?? [], active, startedAt);
          return;
        }
        if (result.status === "error") {
          // Application-level batch failure (transport OK): demux serves each
          // url's per-item error via fallback (and every url if `results` is
          // omitted). The counter is left UNCHANGED — this is not a transport
          // fault (mirrors the legacy RenderJobError path).
          demux(result.results ?? [], active, startedAt);
          return;
        }
        // Per-item early delivery (#992): a non-terminal poll may carry finished
        // jobs' items in `completed`. Settle those waiters now (by url) so they
        // don't block on the batch's slowest render; still-pending urls are left
        // untouched (fallbackUnmatched = false) and keep polling. Idempotent —
        // the per-waiter claim skips items the server re-sends on later polls.
        if (result.completed && result.completed.length > 0) {
          demux(result.completed, active, startedAt, false);
        }
        // Every url retired (settled early and/or aborted) → nothing left to
        // wait for. Stop now instead of polling to aggregate-terminal or the
        // deadline (#992). Covers the case where an early delivery retires the
        // last live url after peers already aborted.
        if (allRetired()) return;
        pollDelay = Math.min(pollDelay * POLL_BACKOFF_FACTOR, pollIntervalMs);
      }
      throw new RenderJobError(`Cloud render timed out after ${timeoutMs}ms`);
    } catch (error) {
      // Caller cancellation (all urls aborted) is not a cloud failure — see above.
      if (!batchAbort.signal.aborted) classifyCloudError(error);
      await settleAllViaFallback(active);
    }
  }

  // Arm the coalescing window (no-op if one is already pending).
  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushOneBatch();
    }, batchWindowMs);
  }

  function flushOneBatch(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const batch = pending.splice(0, maxBatchUrls);
    // Last-resort guard: an unexpected throw (e.g. a user callback) must never
    // leave a waiter unsettled — a hung fetch deadlocks the crawl (#405). Settle
    // any still-pending via HTTP fallback; claim skips waiters already resolved
    // or with a fallback in-flight from a per-item delivery (#992).
    void processBatch(batch).catch(() => {
      for (const w of batch) if (claim(w)) void fallbackWaiter(w);
    });
    // A leftover partial batch (or a backlog beyond one batch) must not stall —
    // give it its own window so stragglers can still join.
    if (pending.length > 0) scheduleFlush();
  }

  function enqueue(w: Waiter): void {
    pending.push(w);
    if (pending.length >= maxBatchUrls) {
      flushOneBatch();
    } else {
      scheduleFlush();
    }
  }

  return {
    id: "cloud-render",
    capabilities: {
      jsRendering: true,
      cookies: false,
      screenshot: false,
    },
    fetch(req: FetchRequest): Promise<FetchResponse> {
      if (fallbackActive) return opts.fallback.fetch(req);
      // Interrupted before we even buffer it → unwind now (no submit/fallback).
      if (req.signal?.aborted) return Promise.reject(abortError());
      return new Promise<FetchResponse>((resolve, reject) => {
        enqueue({ req, resolve, reject, settled: false, dispatched: false });
      });
    },
  };
}
