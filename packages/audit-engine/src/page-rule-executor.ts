// Page-rule execution seam (#263). The page-rules phase is the dominant audit
// cost; isolating it behind a small interface keeps the loop in adapter.ts
// decoupled from execution strategy and independently testable. The only
// shipped backend is in-process serial — attempts to parallelize page rules
// across workers proved a net loss (the linkedom Document can't cross a worker
// boundary, so each worker must re-parse + reload the rule engine, exceeding the
// parallelism gain; see plans/rule-parallelism-263.md).
//
// PREREQUISITE FOR ANY PARALLEL BACKEND: workers can't receive `page.parsed`
// (linkedom Document isn't serializable), so they must re-parse from `page.html`.
// They MUST parse via `parseHtmlForRules` (adapter.ts) — NOT the parser pkg's
// `parsePage`, which builds `links` without `rel`/`isNofollow` and would silently
// drop those fields that real rules consume (weak-internal-links, orphan-pages).

import type { CheckResult, PageData, RuleRunResult, RuleRunner, SiteData } from "@squirrelscan/rules";

/** One page to run page-scope rules on. `key` is the adapter's bucket key
 * (normalizedUrl); `page` carries the raw html + metadata + pre-parsed DOM. */
export interface PageRuleTask {
  key: string;
  page: PageData;
}

/** Per-page rule output the adapter merges. Mirrors the fields the loop consumed
 * from `runPageRules` — `parsed` is intentionally absent (the caller discards it). */
export interface PageRuleTaskResult {
  key: string;
  checks: CheckResult[];
  ruleResults: Map<string, RuleRunResult>;
}

/**
 * Optional per-loop hooks (#1252). Off by default so the CLI/local path is
 * byte-identical to the pre-#1252 loop; the cloud path passes them so a slow
 * rules phase stays observably alive and its deadlines can actually fire.
 */
export interface PageRuleLoopHooks {
  /**
   * Yield to the event loop (a MACROTASK) at least this often (ms) during the
   * loop. Page rules are sync CPU: without a macrotask yield the single thread
   * never returns to the timers phase, so the rules deadline, the post-crawl
   * backstop, AND the container's 30s liveness heartbeat all starve and the
   * stale reaper kills a healthy-but-slow run (#1251). `undefined`/`<=0` → never
   * yield (local parity — CLI runs have no reaper and pay no yield overhead).
   */
  yieldEveryMs?: number;
  /** Emit {@link onProgress} every N completed pages (and once at the end). Default 1. */
  heartbeatEveryPages?: number;
  /** Called with (pagesDone, totalPages) — resets the reaper + shows real advancement. */
  onProgress?: (done: number, total: number) => void;
}

/** Yield to a macrotask so timers/heartbeats queued during sync work can fire. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Runs page-scope rules for a batch of pages, preserving input order and
 * deterministic rule order within each page. `signal` (from the wrapping
 * `Effect.promise`) aborts on fiber interruption — e.g. `rulesPhaseTimeoutMs`
 * firing — and a backend must honor it so a timed-out audit stops promptly
 * instead of running the whole remaining batch to completion. */
export interface PageRuleExecutor {
  run(tasks: PageRuleTask[], siteData: SiteData, signal?: AbortSignal): Promise<PageRuleTaskResult[]>;
  /** Release any held resources. No-op for serial. */
  dispose(): Promise<void>;
}

/**
 * In-process serial backend — runs pages one at a time using each page's
 * pre-parsed DOM. The default and only shipped executor.
 */
export class SerialPageRuleExecutor implements PageRuleExecutor {
  constructor(
    private readonly runner: RuleRunner,
    private readonly hooks?: PageRuleLoopHooks,
  ) {}

  async run(tasks: PageRuleTask[], siteData: SiteData, signal?: AbortSignal): Promise<PageRuleTaskResult[]> {
    const results: PageRuleTaskResult[] = [];
    const total = tasks.length;
    const yieldEveryMs = this.hooks?.yieldEveryMs;
    const heartbeatEvery = Math.max(1, this.hooks?.heartbeatEveryPages ?? 1);
    const onProgress = this.hooks?.onProgress;
    let lastYieldAt = Date.now();
    let done = 0;
    for (const { key, page } of tasks) {
      // Checkpoint between pages: restores the per-page interruption point the
      // pre-#263 loop had (each page was its own `yield* Effect.promise`). Stops
      // starting new pages once the phase timeout has interrupted the fiber.
      signal?.throwIfAborted();
      const r = await this.runner.runPageRules(page, siteData);
      results.push({ key, checks: r.checks, ruleResults: r.ruleResults });
      done++;

      if (onProgress && done % heartbeatEvery === 0) onProgress(done, total);

      // Cooperative macrotask yield: only when a threshold is configured (cloud)
      // and enough sync time has elapsed, so fast pages don't each pay a
      // setTimeout hop. After yielding, the deadline may have interrupted us —
      // re-check before the next page.
      if (yieldEveryMs != null && yieldEveryMs > 0 && Date.now() - lastYieldAt >= yieldEveryMs) {
        await yieldToEventLoop();
        lastYieldAt = Date.now();
        signal?.throwIfAborted();
      }
    }
    // Final progress marker when the last page didn't land on a heartbeat boundary.
    if (onProgress && (done === 0 || done % heartbeatEvery !== 0)) onProgress(done, total);
    return results;
  }

  async dispose(): Promise<void> {}
}

/** Run a batch then always dispose the backend, even on failure. */
export async function runAndDispose(
  executor: PageRuleExecutor,
  tasks: PageRuleTask[],
  siteData: SiteData,
  signal?: AbortSignal,
): Promise<PageRuleTaskResult[]> {
  try {
    return await executor.run(tasks, siteData, signal);
  } finally {
    await executor.dispose();
  }
}
