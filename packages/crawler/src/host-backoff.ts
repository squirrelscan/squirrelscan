// Crawl-wide, per-host rate-limit backoff (squirrelscan/repo#1829).
//
// Before this, a 429 was a per-REQUEST problem: the one URL retried three times
// over ~1.5s while the other four workers kept firing at the same host at the
// configured 50ms stagger. One throttled response therefore cascaded into a
// wave of them, and the pages lost that way were reported as broken 4xx.
//
// This registry makes throttling a HOST-level fact. A single rate-limit response
// pauses every worker aimed at that host, drops the host to one in-flight
// request, and stretches its politeness delay. Recovery is earned back
// gradually over a sustained run of clean responses, not restored at the first
// 200. State is keyed per host, so being throttled by one origin never slows
// external link checks to another.
//
// Deliberately synchronous and clock-injectable: the crawl loop owns the
// sleeping (so a sleep is interruptible by stop()/the watchdog), and the whole
// state machine is unit-testable without real time passing.

import { rateLimitBackoffMs } from "@squirrelscan/utils/rate-limit";

/** First wait when the origin gave no `Retry-After` (#1829: was 500ms). */
export const DEFAULT_RATE_LIMIT_BASE_BACKOFF_MS = 5_000;

/** Cap on a single wait and on the cumulative wait for one host. */
export const DEFAULT_MAX_BACKOFF_MS = 300_000;

/** Consecutive successful responses that earn one step of recovery. */
export const DEFAULT_RECOVERY_SUCCESSES = 20;

/** Per-host delay multiplier applied the moment a host starts throttling. */
export const THROTTLED_DELAY_MULTIPLIER = 10;

/** Per-host concurrency while throttled, before any recovery. */
const THROTTLED_CONCURRENCY = 1;

/**
 * Stand-in politeness delay for a throttled host whose config asked for none.
 * The cloud render path passes 0, and multiplying 0 is still 0 — which would
 * leave a host that just refused us being hit at full rate.
 */
const THROTTLED_MIN_DELAY_MS = 50;

export interface HostBackoffOptions {
  /** Configured per-host concurrency; the ceiling recovery climbs back to. */
  perHostConcurrency: number;
  /** Cap on one wait and on the cumulative wait for a host. */
  maxBackoffMs?: number;
  /** First wait with no `Retry-After`. */
  baseBackoffMs?: number;
  /** Consecutive 2xx that earn one recovery step. */
  recoverySuccesses?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable jitter source for tests. */
  random?: () => number;
}

export interface HostThrottleSnapshot {
  /** Consecutive rate-limit responses since this host started throttling. */
  strikes: number;
  /** Consecutive successful responses since the last rate-limit response. */
  successes: number;
  /** In-flight ceiling for this host right now. */
  concurrency: number;
  /** Multiplier applied to the configured per-host delay right now. */
  delayMultiplier: number;
  /** Total wait this host has been given since it started throttling. */
  cumulativeWaitMs: number;
  /** Spent its whole backoff budget and is still refusing. */
  exhausted: boolean;
  /** Wall-clock time before which no request to this host may start. */
  nextAttemptAt: number;
}

export interface RateLimitOutcome {
  /** How long the caller must wait before the next request to this host. */
  waitMs: number;
  /** True when the host has spent its whole budget: stop fetching it. */
  exhausted: boolean;
  /** Backoff attempt number this wait belongs to (1-based). */
  strikes: number;
}

export interface HostBackoffRegistry {
  /**
   * Record a rate-limit response and arm the host-wide pause. Returns the wait
   * every worker aimed at this host must now observe.
   */
  noteRateLimited(host: string, retryAfterMs?: number): RateLimitOutcome;
  /** Record a successful response; may earn one step of recovery. */
  noteSuccess(host: string): void;
  /** Milliseconds until this host may be requested again (0 when clear). */
  waitMs(host: string): number;
  /** In-flight ceiling for this host (configured value when not throttled). */
  concurrencyFor(host: string): number;
  /** Politeness delay for this host, given the configured delay. */
  delayFor(host: string, configuredDelayMs: number): number;
  /** True once the host spent its backoff budget without recovering. */
  isExhausted(host: string): boolean;
  /** True while the host is in any degraded state. */
  isThrottled(host: string): boolean;
  /** Hosts that gave up, for the report's rate-limited reason. */
  exhaustedHosts(): string[];
  /** Inspect one host's state (tests + diagnostics). */
  snapshot(host: string): HostThrottleSnapshot | null;
  /**
   * Forget every host. Called at the start of each crawl run: exhaustion is
   * terminal WITHIN a run (an exhausted host is skipped before any request, so
   * it can never earn the successes that would recover it), and carrying that
   * verdict into the next crawl on the same crawler instance would record every
   * URL as rate-limited without trying. Also bounds the map's lifetime.
   */
  reset(): void;
}

interface HostThrottleState {
  strikes: number;
  successes: number;
  concurrency: number;
  delayMultiplier: number;
  cumulativeWaitMs: number;
  exhausted: boolean;
  nextAttemptAt: number;
}

/**
 * `Math.max` does not sanitize NaN, and a NaN concurrency or delay poisons the
 * scheduler silently (every comparison against it is false). The CLI's schema
 * blocks bad values, but this package is consumed directly too.
 */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function createHostBackoff(options: HostBackoffOptions): HostBackoffRegistry {
  const configuredConcurrency = Math.max(1, finiteOr(options.perHostConcurrency, 1));
  const maxBackoffMs = Math.max(0, finiteOr(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS));
  const baseBackoffMs = Math.max(
    1,
    finiteOr(options.baseBackoffMs, DEFAULT_RATE_LIMIT_BASE_BACKOFF_MS),
  );
  const recoverySuccesses = Math.max(
    1,
    finiteOr(options.recoverySuccesses, DEFAULT_RECOVERY_SUCCESSES),
  );
  const now = options.now ?? Date.now;
  const random = options.random;

  const hosts = new Map<string, HostThrottleState>();

  const noteRateLimited = (host: string, retryAfterMs?: number): RateLimitOutcome => {
    const state = hosts.get(host) ?? {
      strikes: 0,
      successes: 0,
      concurrency: configuredConcurrency,
      delayMultiplier: 1,
      cumulativeWaitMs: 0,
      exhausted: false,
      nextAttemptAt: 0,
    };

    // Budget already spent on this host and it is still refusing. Give up on it
    // rather than waiting again: the remaining URLs are recorded as
    // rate-limited and the crawl moves on to other hosts.
    if (state.exhausted || state.cumulativeWaitMs >= maxBackoffMs) {
      state.exhausted = true;
      state.strikes += 1;
      state.successes = 0;
      state.concurrency = THROTTLED_CONCURRENCY;
      state.delayMultiplier = THROTTLED_DELAY_MULTIPLIER;
      hosts.set(host, state);
      return { waitMs: 0, exhausted: true, strikes: state.strikes };
    }

    state.strikes += 1;
    state.successes = 0;
    // Throttling resets recovery outright — a host that just refused us gets the
    // full slowdown again, not the partially-recovered settings it had earned.
    state.concurrency = THROTTLED_CONCURRENCY;
    state.delayMultiplier = THROTTLED_DELAY_MULTIPLIER;

    const requested = rateLimitBackoffMs({
      attempt: state.strikes,
      baseDelayMs: baseBackoffMs,
      maxBackoffMs,
      retryAfterMs,
      random,
    });
    // Never let the cumulative wait for one host exceed the cap, even when a
    // single wait is individually under it.
    const remainingBudget = Math.max(0, maxBackoffMs - state.cumulativeWaitMs);
    const waitMs = Math.min(requested, remainingBudget);

    state.cumulativeWaitMs += waitMs;
    const at = now();
    state.nextAttemptAt = Math.max(state.nextAttemptAt, at + waitMs);
    hosts.set(host, state);

    // The caller must observe the host's FULL remaining window, not just the
    // wait this response earned. Two workers refused at the same moment each
    // extend `nextAttemptAt`, and returning only the increment let the first one
    // retry while the second was still waiting — which breaks the "one refusal
    // pauses every worker on this host" guarantee this registry exists for.
    return {
      waitMs: Math.max(0, state.nextAttemptAt - at),
      exhausted: false,
      strikes: state.strikes,
    };
  };

  const noteSuccess = (host: string): void => {
    const state = hosts.get(host);
    if (!state) return;

    state.successes += 1;
    if (state.successes < recoverySuccesses) {
      hosts.set(host, state);
      return;
    }

    // One earned step: double the in-flight ceiling, halve the delay penalty.
    state.successes = 0;
    state.concurrency = Math.min(configuredConcurrency, state.concurrency * 2);
    state.delayMultiplier = Math.max(1, Math.ceil(state.delayMultiplier / 2));

    // Fully recovered — drop the record so the host pays nothing, and give it a
    // fresh backoff budget. An exhausted host can climb all the way back this
    // way, which is what "without recovering" in the cap's definition means.
    if (state.concurrency >= configuredConcurrency && state.delayMultiplier === 1) {
      hosts.delete(host);
      return;
    }
    hosts.set(host, state);
  };

  return {
    noteRateLimited,
    noteSuccess,
    waitMs: (host) => {
      const state = hosts.get(host);
      if (!state) return 0;
      return Math.max(0, state.nextAttemptAt - now());
    },
    concurrencyFor: (host) => hosts.get(host)?.concurrency ?? configuredConcurrency,
    delayFor: (host, configuredDelayMs) => {
      const state = hosts.get(host);
      // No penalty left to apply: either the host never throttled, or it has
      // already earned its configured delay back.
      if (!state || state.delayMultiplier <= 1) return configuredDelayMs;
      // Substitute the floor BEFORE multiplying, so recovery still steps the
      // delay down proportionally instead of being pinned to a flat minimum.
      const base = configuredDelayMs > 0 ? configuredDelayMs : THROTTLED_MIN_DELAY_MS;
      return base * state.delayMultiplier;
    },
    isExhausted: (host) => hosts.get(host)?.exhausted === true,
    isThrottled: (host) => hosts.has(host),
    exhaustedHosts: () =>
      Array.from(hosts.entries())
        .filter(([, state]) => state.exhausted)
        .map(([host]) => host),
    snapshot: (host) => {
      const state = hosts.get(host);
      return state ? { ...state } : null;
    },
    reset: () => {
      hosts.clear();
    },
  };
}
