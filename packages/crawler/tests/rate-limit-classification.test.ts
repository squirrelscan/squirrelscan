// #1829 — a throttled response is not a broken page.
//
// Covers the classification half: which statuses mean "rate limited", how
// `Retry-After` is read (seconds and HTTP-date), and how a wait is bounded.
// The scheduling half lives in rate-limit-backoff.test.ts.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  isRateLimitedResponse,
  isRateLimitStatus,
  parseRetryAfterMs,
  rateLimitBackoffMs,
} from "@squirrelscan/utils/rate-limit";

import { applyStatusGuards, CrawlError } from "../src/fetcher";

const URL = "https://shop.example.com/";

async function guard(
  status: number,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<CrawlError | null> {
  const result = await Effect.runPromise(
    Effect.either(applyStatusGuards(URL, status, new Headers(opts.headers), opts.body)),
  );
  return result._tag === "Left" ? result.left : null;
}

describe("rate-limit status classification (#1829)", () => {
  test("430 is classified exactly like 429", async () => {
    const fourTwentyNine = await guard(429);
    const fourThirty = await guard(430);
    expect(fourTwentyNine?.type).toBe("rate_limit");
    // Shopify answers throttled storefront traffic with 430 ("Shopify Security
    // Rejection"). Nothing classified it before, so it read as a generic 4xx.
    expect(fourThirty?.type).toBe("rate_limit");
  });

  test("430 carries Retry-After the same way 429 does", async () => {
    const error = await guard(430, { headers: { "retry-after": "12" } });
    expect(error?.type).toBe("rate_limit");
    expect(error?.retryAfterMs).toBe(12_000);
  });

  test("503 WITH Retry-After is rate limiting", async () => {
    const error = await guard(503, { headers: { "retry-after": "45" } });
    expect(error?.type).toBe("rate_limit");
    expect(error?.retryAfterMs).toBe(45_000);
  });

  test("503 WITHOUT Retry-After stays a server error", async () => {
    const error = await guard(503, { body: "Service temporarily unavailable" });
    expect(error?.type).toBe("network");
    expect(error?.message).toContain("503");
  });

  test("a bot-challenge 503 stays blocked even when it sends Retry-After", async () => {
    // A challenge never clears on retry, so backing off would waste the whole
    // budget on a wall. The challenge check has to win over the Retry-After one.
    const error = await guard(503, {
      headers: { "cf-mitigated": "challenge", "retry-after": "30" },
    });
    expect(error?.type).toBe("blocked");
  });

  test("403 stays blocked, not rate limited", async () => {
    const error = await guard(403);
    expect(error?.type).toBe("blocked");
  });

  test("the rate-limit message names the status so the report can explain itself", async () => {
    const error = await guard(430, { headers: { "retry-after": "7" } });
    expect(error?.message).toContain("430");
    expect(error?.message).toContain("7s");
  });
});

describe("isRateLimitStatus / isRateLimitedResponse (#1829)", () => {
  test("429 and 430 are unconditional; other 4xx are not", () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(430)).toBe(true);
    expect(isRateLimitStatus(404)).toBe(false);
    expect(isRateLimitStatus(403)).toBe(false);
    expect(isRateLimitStatus(null)).toBe(false);
    expect(isRateLimitStatus(undefined)).toBe(false);
  });

  test("503 depends entirely on Retry-After", () => {
    expect(isRateLimitedResponse(503, "30")).toBe(true);
    expect(isRateLimitedResponse(503, null)).toBe(false);
    expect(isRateLimitedResponse(503, "   ")).toBe(false);
    expect(isRateLimitedResponse(503, undefined)).toBe(false);
  });
});

describe("parseRetryAfterMs (#1829)", () => {
  test("delay-seconds", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("HTTP-date, resolved against the supplied clock", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:30 GMT", now)).toBe(30_000);
  });

  test("an HTTP-date already in the past means retry now, never a negative wait", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:27:00 GMT", now)).toBe(0);
  });

  test("absent or malformed values fall through to the caller's own schedule", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    // "7 days" must NOT be read as 7 seconds the way parseInt would.
    expect(parseRetryAfterMs("7 days")).toBeUndefined();
  });
});

describe("rateLimitBackoffMs (#1829)", () => {
  const noJitter = () => 0;

  test("with no Retry-After the first wait is the 5s base and doubles per attempt", () => {
    const wait = (attempt: number) =>
      rateLimitBackoffMs({
        attempt,
        baseDelayMs: 5_000,
        maxBackoffMs: 300_000,
        random: noJitter,
      });
    expect(wait(1)).toBe(5_000);
    expect(wait(2)).toBe(10_000);
    expect(wait(3)).toBe(20_000);
    expect(wait(4)).toBe(40_000);
    expect(wait(5)).toBe(80_000);
    // Five retries fit inside the 5-minute cap, which is the contract that
    // makes "at least 5 attempts" reachable.
    expect(wait(1) + wait(2) + wait(3) + wait(4) + wait(5)).toBeLessThan(300_000);
  });

  test("jitter only ever adds, and never more than a quarter", () => {
    const base = rateLimitBackoffMs({
      attempt: 1,
      baseDelayMs: 5_000,
      maxBackoffMs: 300_000,
      random: () => 1,
    });
    expect(base).toBe(6_250);
  });

  test("Retry-After wins over the exponential schedule", () => {
    const wait = rateLimitBackoffMs({
      attempt: 4,
      baseDelayMs: 5_000,
      maxBackoffMs: 300_000,
      retryAfterMs: 7_000,
      random: noJitter,
    });
    expect(wait).toBe(7_000);
  });

  test("a Retry-After above max_backoff_ms is clamped to it", () => {
    const wait = rateLimitBackoffMs({
      attempt: 1,
      baseDelayMs: 5_000,
      maxBackoffMs: 300_000,
      retryAfterMs: 3_600_000,
      random: noJitter,
    });
    expect(wait).toBe(300_000);
  });

  test("a far-out attempt number cannot overflow into NaN", () => {
    // 2 ** 1024 is Infinity, and Infinity * base meets the jitter multiply as
    // NaN — which would sleep forever rather than fail.
    const wait = rateLimitBackoffMs({
      attempt: 5_000,
      baseDelayMs: 5_000,
      maxBackoffMs: 300_000,
      random: () => 0.5,
    });
    expect(Number.isFinite(wait)).toBe(true);
    expect(wait).toBe(300_000);
  });
});
