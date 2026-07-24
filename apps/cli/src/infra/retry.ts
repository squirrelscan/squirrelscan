// Retry schedules and policies for SquirrelScan
// Uses Effect's Schedule for exponential backoff and retry logic

import { Effect, Schedule, Duration, pipe } from "effect";

import { type GraphError, isRetryable, getRetryDelay } from "./errors";

// ============================================
// RETRY SCHEDULES
// ============================================

/**
 * Default exponential backoff schedule
 * Starts at 500ms, multiplies by 2 each retry, up to 3 retries
 */
export const exponentialBackoff = pipe(
  Schedule.exponential(Duration.millis(500), 2),
  Schedule.compose(Schedule.recurs(3))
);

/**
 * Aggressive retry for rate limits
 * Longer delays, more retries
 */
export const rateLimitSchedule = pipe(
  Schedule.exponential(Duration.seconds(2), 1.5),
  Schedule.compose(Schedule.recurs(5)),
  Schedule.addDelay(() => Duration.millis(Math.random() * 1000)) // Jitter
);

/**
 * Quick retry for transient errors
 * Short delays, few retries
 */
export const transientSchedule = pipe(
  Schedule.exponential(Duration.millis(100), 2),
  Schedule.compose(Schedule.recurs(2))
);

/**
 * Fixed delay schedule (useful for testing)
 */
export const fixedDelaySchedule = (delayMs: number, maxRetries: number) =>
  pipe(
    Schedule.fixed(Duration.millis(delayMs)),
    Schedule.compose(Schedule.recurs(maxRetries))
  );

// ============================================
// RETRY POLICIES
// ============================================

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

export const aggressiveRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  backoffMultiplier: 1.5,
  jitter: true,
};

/**
 * Create a schedule from a retry policy
 */
export function createScheduleFromPolicy(policy: RetryPolicy) {
  let schedule = pipe(
    Schedule.exponential(
      Duration.millis(policy.baseDelayMs),
      policy.backoffMultiplier
    ),
    Schedule.compose(Schedule.recurs(policy.maxAttempts - 1))
  );

  // Add jitter if enabled
  if (policy.jitter) {
    schedule = Schedule.addDelay(schedule, () =>
      Duration.millis(Math.random() * policy.baseDelayMs * 0.5)
    );
  }

  return schedule;
}

// ============================================
// RETRY HELPERS
// ============================================

/**
 * Retry an effect with exponential backoff, only for retryable errors
 */
export function withRetry<A, E extends GraphError, R>(
  effect: Effect.Effect<A, E, R>,
  policy: RetryPolicy = defaultRetryPolicy
): Effect.Effect<A, E, R> {
  const schedule = createScheduleFromPolicy(policy);

  return Effect.retry(effect, {
    schedule,
    while: (error) => isRetryable(error),
  });
}

/**
 * Retry with custom retry-after handling (for rate limits)
 */
export function withRateLimitRetry<A, E extends GraphError, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.catchAll(effect, (error) => {
    const retryDelay = getRetryDelay(error);
    if (retryDelay) {
      return pipe(
        Effect.sleep(Duration.seconds(retryDelay)),
        Effect.flatMap(() => effect)
      );
    }
    return Effect.fail(error);
  });
}

/**
 * Retry with fallback - try primary, then fallback on failure
 */
export function withFallback<A, E, R>(
  primary: Effect.Effect<A, E, R>,
  fallback: Effect.Effect<A, E, R>,
  shouldFallback: (error: E) => boolean = () => true
): Effect.Effect<A, E, R> {
  return Effect.catchAll(primary, (error) => {
    if (shouldFallback(error)) {
      return fallback;
    }
    return Effect.fail(error);
  });
}

/**
 * Add timeout to an effect
 */
export function withTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number
): Effect.Effect<A, E | { _tag: "Timeout" }, R> {
  return Effect.timeoutFail(effect, {
    duration: Duration.millis(timeoutMs),
    onTimeout: () => ({ _tag: "Timeout" as const }),
  });
}

// ============================================
// CIRCUIT BREAKER (future enhancement)
// ============================================

export interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

export function createCircuitBreaker(
  _threshold: number = 5,
  _resetTimeMs: number = 60000
): CircuitBreakerState {
  return {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
  };
}
