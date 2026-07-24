// Tarpit-aware fetch budget (#1252). Bounds the resource-asset fetch step (and
// any other HTTP fan-out threaded through it) two ways at once:
//
//   1. TOTAL wall-clock cap — once `totalBudgetMs` has elapsed, every not-yet-
//      started fetch is skipped instead of launched, so a slow host can't stretch
//      the phase past its budget. Per-request timeouts (the caller's own
//      AbortController) still bound whatever is already in flight.
//   2. PER-HOST tarpit detection — a request slower than `tarpitLatencyMs`, or one
//      that aborts/errors, is a "strike" against its host; `tarpitStrikes`
//      consecutive strikes skip that host's REMAINING fetches. A fast success
//      resets the streak, so one slow asset never trips the skip.
//
// The budget is a SKIP gate, not a canceller: it prevents new work, which yields
// PARTIAL results (completed fetches keep their data, skipped ones return a
// caller-supplied "skipped" placeholder) instead of the old all-or-nothing empty
// cliff. `summary()` reports whether the phase degraded and why, so the caller can
// surface a degradation note in the report.
//
// Framework-free and clock-injectable for deterministic tests.

export type FetchOutcome = "ok" | "timeout" | "error" | "skipped";

export interface FetchBudgetOptions {
  /** Absolute wall-clock cap (ms) across every fetch sharing this budget. `undefined`/`<=0` → no cap. */
  totalBudgetMs?: number;
  /** A single request whose wall time meets/exceeds this (ms) is a tarpit strike. `undefined`/`<=0` → latency never strikes (only aborts/errors do). */
  tarpitLatencyMs?: number;
  /** Consecutive strikes on ONE host before its remaining fetches are skipped. `<=0` → per-host tarpit skipping disabled. */
  tarpitStrikes?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface FetchBudgetSummary {
  /** True once anything was skipped for budget or tarpit reasons. */
  degraded: boolean;
  /** First reason the phase degraded (budget exhaustion takes precedence). */
  reason?: "budget" | "tarpit";
  /** Count of fetches skipped (budget deadline passed or host tarpitting). */
  skipped: number;
  /** Count of fetches actually attempted (recorded via {@link FetchBudget.record}). */
  attempted: number;
  /** Hosts flagged as tarpitting (remaining fetches skipped). */
  tarpitHosts: string[];
  /** Wall time (ms) since the budget was created. */
  elapsedMs: number;
}

export interface FetchBudget {
  /**
   * Call BEFORE launching a fetch. Returns true to SKIP it — because the total
   * budget is exhausted or the URL's host is tarpitting. A `true` return also
   * counts the skip toward {@link summary}.
   */
  shouldSkip(url: string): boolean;
  /**
   * Record a completed attempt's wall time + outcome so tarpit strikes update.
   * `outcome` "timeout"/"error" always strikes; "ok" strikes only if slow.
   */
  record(url: string, elapsedMs: number, outcome: FetchOutcome): void;
  /** Snapshot of degradation state; safe to call at any time. */
  summary(): FetchBudgetSummary;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Create a {@link FetchBudget}. With no bounding options it is inert — `shouldSkip`
 * always returns false and `summary().degraded` stays false — so callers can
 * always create one and only the cloud path (which passes real limits) engages it.
 */
export function createFetchBudget(options: FetchBudgetOptions = {}): FetchBudget {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const hasBudget = !!options.totalBudgetMs && options.totalBudgetMs > 0;
  const deadlineAt = hasBudget ? startedAt + options.totalBudgetMs! : Number.POSITIVE_INFINITY;
  const tarpitLatencyMs =
    options.tarpitLatencyMs && options.tarpitLatencyMs > 0
      ? options.tarpitLatencyMs
      : Number.POSITIVE_INFINITY;
  const tarpitStrikes =
    options.tarpitStrikes && options.tarpitStrikes > 0 ? options.tarpitStrikes : 0;

  const hostStrikes = new Map<string, number>();
  const tarpitHosts = new Set<string>();
  let skipped = 0;
  let attempted = 0;
  let degraded = false;
  let reason: "budget" | "tarpit" | undefined;

  const markDegraded = (r: "budget" | "tarpit") => {
    degraded = true;
    // Budget exhaustion is the broader signal; don't let a later tarpit overwrite it.
    if (reason === undefined || (reason === "tarpit" && r === "budget")) reason = r;
  };

  return {
    shouldSkip(url) {
      if (now() >= deadlineAt) {
        skipped++;
        markDegraded("budget");
        return true;
      }
      if (tarpitStrikes > 0 && tarpitHosts.has(hostOf(url))) {
        skipped++;
        markDegraded("tarpit");
        return true;
      }
      return false;
    },
    record(url, elapsedMs, outcome) {
      attempted++;
      if (tarpitStrikes <= 0) return;
      const host = hostOf(url);
      if (tarpitHosts.has(host)) return;
      const isStrike = outcome === "timeout" || outcome === "error" || elapsedMs >= tarpitLatencyMs;
      if (!isStrike) {
        // A fast, clean success clears the streak — transient slowness ≠ tarpit.
        hostStrikes.set(host, 0);
        return;
      }
      const next = (hostStrikes.get(host) ?? 0) + 1;
      hostStrikes.set(host, next);
      if (next >= tarpitStrikes) {
        tarpitHosts.add(host);
        markDegraded("tarpit");
      }
    },
    summary() {
      return {
        degraded,
        reason,
        skipped,
        attempted,
        tarpitHosts: [...tarpitHosts],
        elapsedMs: now() - startedAt,
      };
    },
  };
}
