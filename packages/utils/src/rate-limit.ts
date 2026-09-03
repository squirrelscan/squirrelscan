// Rate-limit classification shared by the crawler, the link/resource checkers
// and the rules (squirrelscan/repo#1829).
//
// A throttled response is NOT a broken page. Before this module every consumer
// re-derived "is this a 4xx?" from the status alone, so a 429 (or Shopify's
// 430) was indistinguishable from a real 404 and got reported as a dead link.
// Every place that decides "broken" now asks the same two questions here.

/**
 * Statuses that mean "you are being throttled", independent of any header.
 *
 * - 429 Too Many Requests (RFC 6585).
 * - 430 is not registered with IANA; Shopify returns it as "Shopify Security
 *   Rejection" for storefront traffic it considers aggressive. Treated exactly
 *   like 429 because that is what it means in the one place it occurs.
 */
export const RATE_LIMIT_STATUSES: readonly number[] = [429, 430];

const RATE_LIMIT_STATUS_SET = new Set(RATE_LIMIT_STATUSES);

/** True for a status that always means rate limiting (429 / 430). */
export function isRateLimitStatus(status: number | null | undefined): boolean {
  return status != null && RATE_LIMIT_STATUS_SET.has(status);
}

/**
 * True when the response should be read as throttling rather than a failure.
 *
 * 503 is the ambiguous one: a bare 503 is an outage (and stays a server error),
 * but a 503 that carries `Retry-After` is the origin explicitly asking us to
 * come back later, which is the same contract as a 429.
 */
export function isRateLimitedResponse(
  status: number | null | undefined,
  retryAfterHeader?: string | null,
): boolean {
  if (isRateLimitStatus(status)) return true;
  return status === 503 && hasRetryAfter(retryAfterHeader);
}

function hasRetryAfter(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Upper bound on a parsed `Retry-After`, so an absurd value can't be trusted into a hang. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Accepts both RFC 9110 forms: delay-seconds (`Retry-After: 7`) and an
 * HTTP-date (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`). A date already in
 * the past yields 0 (retry immediately), never a negative wait. `now` is
 * injectable so the date branch is testable without freezing the clock.
 *
 * Returns undefined for an absent, malformed, or implausibly large value —
 * callers then fall back to their own exponential schedule, which is bounded.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!hasRetryAfter(value)) return undefined;
  const raw = value!.trim();

  // delay-seconds. Deliberately strict: `Number.parseInt` would read "7 days"
  // as 7, and a header that is not a bare integer is more likely a date.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return undefined;
    const ms = seconds * 1000;
    return ms > MAX_RETRY_AFTER_MS ? MAX_RETRY_AFTER_MS : ms;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  if (ms <= 0) return 0;
  return ms > MAX_RETRY_AFTER_MS ? MAX_RETRY_AFTER_MS : ms;
}

/**
 * Floor on any rate-limit wait.
 *
 * A `Retry-After: 0` (or an HTTP-date already in the past) is a broken origin
 * telling us to come back immediately while still refusing us. Honouring it
 * literally produces a hot retry loop that sleeps for nothing, never
 * accumulates against the backoff cap, and therefore never gives up — the exact
 * failure this whole mechanism exists to prevent. One second is short enough to
 * respect a genuinely brief window and long enough to stop a burst.
 */
export const MIN_RATE_LIMIT_WAIT_MS = 1_000;

/**
 * Exponential backoff for a rate-limited request, in milliseconds.
 *
 * `attempt` is 1-based (1 = the wait before the first retry). `Retry-After`
 * always wins when the origin sent one — it is an instruction, not a hint — but
 * is still clamped to `maxBackoffMs` so a hostile or broken header cannot park
 * a crawl for hours.
 *
 * Jitter is additive and one-sided (0 to 25% of the computed wait) so a burst of
 * workers throttled by the same host doesn't resume in lockstep and re-trip it.
 */
export function rateLimitBackoffMs(options: {
  attempt: number;
  baseDelayMs: number;
  maxBackoffMs: number;
  retryAfterMs?: number;
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number;
}): number {
  const { attempt, baseDelayMs, maxBackoffMs, retryAfterMs, random } = options;
  const cap = Math.max(0, maxBackoffMs);

  if (retryAfterMs !== undefined) {
    // Floored, not just clamped: see MIN_RATE_LIMIT_WAIT_MS. The floor itself is
    // capped, so a maxBackoffMs below it still wins.
    return Math.min(Math.max(MIN_RATE_LIMIT_WAIT_MS, retryAfterMs), cap);
  }

  const exponent = Math.max(0, attempt - 1);
  // Cap the exponent before the shift: 2 ** 1024 is Infinity, and
  // Infinity * baseDelayMs is NaN once it meets the jitter multiply.
  const growth = 2 ** Math.min(exponent, 30);
  const base = Math.min(baseDelayMs * growth, cap);
  const jitter = base * 0.25 * (random ? random() : Math.random());
  return Math.min(Math.max(MIN_RATE_LIMIT_WAIT_MS, base + jitter), cap);
}
