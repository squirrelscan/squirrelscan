// Request deadlines that survive into the body read (#1699), and the phase
// budget that bounds a whole sequence of them (squirrelscan/repo#1733).

import { PROBE_NOT_ATTEMPTED_ERROR } from "@squirrelscan/core-contracts/storage";
import { safeRedirectFetch } from "@squirrelscan/utils/safe-fetch";

/**
 * Run a request under a deadline that stays armed until its body has been read.
 *
 * The tempting shape — `fetch(...).finally(() => clearTimeout(timer))` — disarms
 * the abort the moment the response HEADERS land, which leaves the body read
 * with no time bound at all: an origin that answers 200 promptly and then
 * trickles or stalls the body parks the caller forever. `readBodyCapped` caps
 * BYTES, not seconds, so it cannot save you either. Holding the timer across
 * `use` means such a stall aborts the body stream instead of hanging.
 *
 * `use` must finish with the response (read or cancel its body) before it
 * returns — the deadline is disarmed as soon as it does.
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  perform: (signal: AbortSignal) => Promise<Response>,
  use: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await use(await perform(controller.signal));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * `withRequestDeadline` over `safeRedirectFetch` — the shape every root probe in
 * the crawl preamble (robots, llms, markdown, well-known, agent-access, rsl,
 * sitemaps) uses. Manual redirects apply the per-hop scheme allowlist and strip
 * secret customHeaders when the origin changes (#1395).
 */
export function safeFetchWithDeadline<T>(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  use: (response: Response) => Promise<T>,
): Promise<T> {
  return withRequestDeadline(
    timeoutMs,
    (signal) => safeRedirectFetch(url, { ...options, signal }).then((result) => result.response),
    use,
  );
}

/**
 * A wall-clock budget shared by every request in one crawl phase.
 *
 * Per-request deadlines bound one request each; they say nothing about a
 * SEQUENCE of them. The crawl preamble is seven sequential stages carrying
 * 15-30s deadlines apiece, so what a caller actually waits through is their sum
 * — 150s against an origin that answers 200 on every root path and then stalls
 * the body, which is the entire crawl phase a quick cloud audit gets
 * (squirrelscan/repo#1733). One budget spans the phase and each request takes
 * whatever is left of it.
 *
 * Absolute (an epoch deadline), not a countdown: stages are sequential and some
 * fan out internally, so time already spent has to stay spent no matter which
 * stage asks.
 */
export interface PhaseBudget {
  /** Epoch ms past which no further request in the phase may start. */
  readonly deadlineAt: number;
}

/**
 * Error text recorded by a probe that was skipped because the budget ran out.
 * Shared with the rules package via core-contracts: consumers key off this
 * exact string to tell "never attempted" apart from "attempted and failed",
 * which look identical otherwise (both are `status: 0`).
 */
export const BUDGET_EXHAUSTED_ERROR = PROBE_NOT_ATTEMPTED_ERROR;

export function createPhaseBudget(totalMs: number, startedAt: number = Date.now()): PhaseBudget {
  return { deadlineAt: startedAt + Math.max(0, totalMs) };
}

/** Milliseconds left on the budget, floored at 0. `Infinity` when unbudgeted. */
export function budgetRemainingMs(budget: PhaseBudget | undefined): number {
  if (!budget) return Number.POSITIVE_INFINITY;
  return Math.max(0, budget.deadlineAt - Date.now());
}

/**
 * The deadline one request may use: its own timeout, clamped to what the phase
 * has left.
 *
 * `null` means the budget is spent and the request must be SKIPPED — the caller
 * returns its normal unreachable/empty shape, the same one a network failure
 * produces, so nothing downstream needs a new code path. `null` rather than `0`
 * on purpose: a numeric zero reads as "no timeout" at a glance, and skipping is
 * not something a caller may quietly ignore.
 */
export function budgetedTimeoutMs(
  budget: PhaseBudget | undefined,
  requestTimeoutMs: number,
): number | null {
  const remaining = budgetRemainingMs(budget);
  if (remaining <= 0) return null;
  return Math.min(requestTimeoutMs, remaining);
}
