// #1829 — the scheduling half of rate-limit handling.
//
// Two layers are asserted here, both on a fake clock so nothing sleeps:
//   1. the per-host registry (crawl-wide pause, concurrency drop, recovery,
//      cumulative cap and exhaustion, per-host isolation);
//   2. `fetchPageWithRetry`'s retry schedule driven through the injected
//      `rateLimit` control, so the waits it asks for are observable without
//      waiting them out.

import { describe, expect, test } from "bun:test";
import { Effect, Either, Fiber, TestClock, TestContext } from "effect";

import { createHostBackoff } from "../src/host-backoff";
import {
  CrawlError,
  RATE_LIMIT_MAX_ATTEMPTS,
  fetchPageWithRetry,
  type FetchOptions,
  type FetchResult,
  type RateLimitControl,
  type RateLimitEncounter,
} from "../src/fetcher";

const HOST_A = "shop.example.com";
const HOST_B = "cdn.example.net";

/** A registry on a clock the test moves by hand. */
function registryAt(startMs: number, overrides: Record<string, unknown> = {}) {
  let now = startMs;
  const registry = createHostBackoff({
    perHostConcurrency: 5,
    maxBackoffMs: 300_000,
    baseBackoffMs: 5_000,
    recoverySuccesses: 20,
    now: () => now,
    // No jitter: every assertion below is about the schedule, not the noise.
    random: () => 0,
    ...overrides,
  });
  return {
    registry,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("host backoff registry — crawl-wide pause (#1829)", () => {
  test("one rate-limit response pauses the whole host and drops it to concurrency 1", () => {
    const { registry } = registryAt(0);
    expect(registry.concurrencyFor(HOST_A)).toBe(5);
    expect(registry.waitMs(HOST_A)).toBe(0);

    const outcome = registry.noteRateLimited(HOST_A);

    expect(outcome.waitMs).toBe(5_000);
    expect(outcome.exhausted).toBe(false);
    // Every other worker aimed at this host now has to wait, which is the
    // whole point: one 429 used to cost one URL while four workers kept firing.
    expect(registry.waitMs(HOST_A)).toBe(5_000);
    expect(registry.concurrencyFor(HOST_A)).toBe(1);
    expect(registry.isThrottled(HOST_A)).toBe(true);
  });

  test("a throttled host is left alone until its window elapses", () => {
    const { registry, advance } = registryAt(0);
    registry.noteRateLimited(HOST_A);

    advance(2_000);
    expect(registry.waitMs(HOST_A)).toBe(3_000);
    advance(3_000);
    expect(registry.waitMs(HOST_A)).toBe(0);
  });

  test("another host is completely unaffected", () => {
    const { registry } = registryAt(0);
    registry.noteRateLimited(HOST_A);

    expect(registry.waitMs(HOST_B)).toBe(0);
    expect(registry.concurrencyFor(HOST_B)).toBe(5);
    expect(registry.isThrottled(HOST_B)).toBe(false);
    // External link checks to other origins must keep running at full speed.
    expect(registry.delayFor(HOST_B, 50)).toBe(50);
  });

  test("the per-host delay is multiplied while throttled", () => {
    const { registry } = registryAt(0);
    expect(registry.delayFor(HOST_A, 50)).toBe(50);
    registry.noteRateLimited(HOST_A);
    expect(registry.delayFor(HOST_A, 50)).toBe(500);
  });

  test("a throttled host still slows down when the config asked for no stagger", () => {
    // The cloud render path passes delayMs 0. Multiplying 0 is still 0, which
    // would leave a throttled host hammered at full rate.
    const { registry } = registryAt(0);
    registry.noteRateLimited(HOST_A);
    expect(registry.delayFor(HOST_A, 0)).toBeGreaterThan(0);
  });

  test("repeated rate limits grow the window", () => {
    const { registry, advance } = registryAt(0);
    expect(registry.noteRateLimited(HOST_A).waitMs).toBe(5_000);
    advance(5_000);
    expect(registry.noteRateLimited(HOST_A).waitMs).toBe(10_000);
    advance(10_000);
    expect(registry.noteRateLimited(HOST_A).waitMs).toBe(20_000);
  });

  test("Retry-After sets the floor for the next attempt to that host", () => {
    const { registry } = registryAt(0);
    const outcome = registry.noteRateLimited(HOST_A, 7_000);
    expect(outcome.waitMs).toBe(7_000);
    expect(registry.waitMs(HOST_A)).toBe(7_000);
  });

  test("a Retry-After beyond max_backoff_ms is clamped to it", () => {
    const { registry } = registryAt(0);
    const outcome = registry.noteRateLimited(HOST_A, 3_600_000);
    expect(outcome.waitMs).toBe(300_000);
  });
});

describe("host backoff registry — concurrent refusals (#1829 review)", () => {
  test("every worker is told the host's FULL remaining window, not just its own increment", () => {
    // Two workers refused at the same instant each extend `nextAttemptAt`.
    // Returning only the increment let the first retry while the second was
    // still waiting, which breaks the "one refusal pauses every worker" promise.
    const { registry } = registryAt(0);

    const first = registry.noteRateLimited(HOST_A);
    const second = registry.noteRateLimited(HOST_A);

    expect(first.waitMs).toBe(5_000);
    // The second refusal is the second strike, so its own wait is 10s from now —
    // past the first worker's 5s window. Both workers are told 10s, which is the
    // whole point: neither may touch the host before the window closes.
    expect(second.waitMs).toBe(10_000);
    expect(registry.waitMs(HOST_A)).toBe(10_000);
  });

  test("a later refusal never shortens an existing window", () => {
    const { registry } = registryAt(0);
    registry.noteRateLimited(HOST_A, 60_000);
    const shorter = registry.noteRateLimited(HOST_A, 1_000);
    expect(shorter.waitMs).toBe(60_000);
  });
});

describe("host backoff registry — degenerate Retry-After (#1829 review)", () => {
  test("Retry-After: 0 is floored, so retries cannot burst", () => {
    // A server answering 429 while saying "come back now" is broken. Honouring
    // it literally produced a hot loop that slept for nothing.
    const { registry } = registryAt(0);
    const outcome = registry.noteRateLimited(HOST_A, 0);
    expect(outcome.waitMs).toBeGreaterThanOrEqual(1_000);
  });

  test("a zero Retry-After still accumulates toward exhaustion", () => {
    // With a zero wait, `cumulativeWaitMs` never grew, so the host could never
    // be given up on and every frontier URL repeated the burst.
    const { registry, advance } = registryAt(0, { maxBackoffMs: 5_000 });

    let outcome = registry.noteRateLimited(HOST_A, 0);
    let guard = 0;
    while (!outcome.exhausted && guard++ < 50) {
      advance(outcome.waitMs);
      outcome = registry.noteRateLimited(HOST_A, 0);
    }

    expect(outcome.exhausted).toBe(true);
    expect(guard).toBeLessThan(50);
  });
});

describe("host backoff registry — reset (#1829 review)", () => {
  test("reset clears an exhausted host so the next crawl starts clean", () => {
    // Exhaustion is terminal WITHIN a run — an exhausted host is skipped before
    // any request, so it can never earn the successes that recover it. Carrying
    // that verdict into the next crawl would record every URL untried.
    const { registry } = registryAt(0, { maxBackoffMs: 1_000 });
    registry.noteRateLimited(HOST_A);
    registry.noteRateLimited(HOST_A);
    expect(registry.isExhausted(HOST_A)).toBe(true);

    registry.reset();

    expect(registry.isExhausted(HOST_A)).toBe(false);
    expect(registry.isThrottled(HOST_A)).toBe(false);
    expect(registry.concurrencyFor(HOST_A)).toBe(5);
    expect(registry.waitMs(HOST_A)).toBe(0);
  });
});

describe("host backoff registry — malformed options (#1829 review)", () => {
  test("NaN inputs cannot poison the scheduler", () => {
    // Math.max does not sanitize NaN, and a NaN concurrency makes every
    // comparison against it false — the host would silently go unlimited.
    const registry = createHostBackoff({
      perHostConcurrency: Number.NaN,
      maxBackoffMs: Number.NaN,
      baseBackoffMs: Number.NaN,
      recoverySuccesses: Number.NaN,
    });
    expect(Number.isFinite(registry.concurrencyFor(HOST_A))).toBe(true);
    const outcome = registry.noteRateLimited(HOST_A);
    expect(Number.isFinite(outcome.waitMs)).toBe(true);
    expect(Number.isFinite(registry.delayFor(HOST_A, 50))).toBe(true);
  });
});

describe("host backoff registry — recovery (#1829)", () => {
  test("concurrency and delay climb back over consecutive successes", () => {
    const { registry } = registryAt(0);
    registry.noteRateLimited(HOST_A);
    expect(registry.concurrencyFor(HOST_A)).toBe(1);
    expect(registry.delayFor(HOST_A, 50)).toBe(500);

    const succeed = (n: number) => {
      for (let i = 0; i < n; i++) registry.noteSuccess(HOST_A);
    };

    // Nineteen clean responses are not yet a sustained run.
    succeed(19);
    expect(registry.concurrencyFor(HOST_A)).toBe(1);

    succeed(1); // 20 → one step
    expect(registry.concurrencyFor(HOST_A)).toBe(2);
    expect(registry.delayFor(HOST_A, 50)).toBe(250);

    succeed(20); // 40 → two steps
    expect(registry.concurrencyFor(HOST_A)).toBe(4);
    expect(registry.delayFor(HOST_A, 50)).toBe(150);

    succeed(20); // 60 → concurrency back at the configured ceiling
    expect(registry.concurrencyFor(HOST_A)).toBe(5);
    expect(registry.delayFor(HOST_A, 50)).toBe(100);

    succeed(20); // 80 → delay penalty gone, host fully recovered
    expect(registry.concurrencyFor(HOST_A)).toBe(5);
    expect(registry.delayFor(HOST_A, 50)).toBe(50);
    expect(registry.isThrottled(HOST_A)).toBe(false);
  });

  test("a new rate limit throws recovery away rather than continuing from it", () => {
    const { registry } = registryAt(0);
    registry.noteRateLimited(HOST_A);
    for (let i = 0; i < 40; i++) registry.noteSuccess(HOST_A);
    expect(registry.concurrencyFor(HOST_A)).toBe(4);

    registry.noteRateLimited(HOST_A);
    expect(registry.concurrencyFor(HOST_A)).toBe(1);
    expect(registry.delayFor(HOST_A, 50)).toBe(500);
  });

  test("successes on a host that never throttled are free", () => {
    const { registry } = registryAt(0);
    registry.noteSuccess(HOST_B);
    expect(registry.isThrottled(HOST_B)).toBe(false);
    expect(registry.concurrencyFor(HOST_B)).toBe(5);
  });
});

describe("host backoff registry — exhaustion (#1829)", () => {
  test("a host that never relents gives up once it has spent max_backoff_ms", () => {
    const { registry, advance } = registryAt(0, { maxBackoffMs: 30_000 });

    let spent = 0;
    let outcome = registry.noteRateLimited(HOST_A);
    while (!outcome.exhausted && spent < 200_000) {
      spent += outcome.waitMs;
      advance(outcome.waitMs);
      outcome = registry.noteRateLimited(HOST_A);
    }

    expect(outcome.exhausted).toBe(true);
    expect(registry.isExhausted(HOST_A)).toBe(true);
    expect(registry.exhaustedHosts()).toEqual([HOST_A]);
    // The cumulative wait is bounded by the cap, not by the number of attempts.
    expect(registry.snapshot(HOST_A)!.cumulativeWaitMs).toBeLessThanOrEqual(30_000);
  });

  test("an exhausted host asks for no further waiting", () => {
    const { registry } = registryAt(0, { maxBackoffMs: 1_000 });
    registry.noteRateLimited(HOST_A); // spends the whole 1s budget
    const second = registry.noteRateLimited(HOST_A);
    expect(second.exhausted).toBe(true);
    expect(second.waitMs).toBe(0);
  });

  test("exhaustion is per host: a healthy host keeps crawling", () => {
    const { registry } = registryAt(0, { maxBackoffMs: 1_000 });
    registry.noteRateLimited(HOST_A);
    registry.noteRateLimited(HOST_A);
    expect(registry.isExhausted(HOST_A)).toBe(true);
    expect(registry.isExhausted(HOST_B)).toBe(false);
    expect(registry.exhaustedHosts()).not.toContain(HOST_B);
  });

  test("a recovered host gets a fresh budget", () => {
    const { registry } = registryAt(0, { maxBackoffMs: 1_000 });
    registry.noteRateLimited(HOST_A);
    registry.noteRateLimited(HOST_A);
    expect(registry.isExhausted(HOST_A)).toBe(true);

    // 80 clean responses walk it all the way back, which clears the record.
    for (let i = 0; i < 80; i++) registry.noteSuccess(HOST_A);
    expect(registry.isExhausted(HOST_A)).toBe(false);
    expect(registry.noteRateLimited(HOST_A).exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchPageWithRetry's schedule, driven through the injected control.
// ---------------------------------------------------------------------------

/** A fetch seam that fails with rate limiting a fixed number of times. */
function throttlingFetcher(failures: number, retryAfterMs?: number) {
  let calls = 0;
  const options = (control: RateLimitControl): FetchOptions => ({
    userAgent: "test",
    timeoutMs: 1_000,
    followRedirects: false,
    rateLimit: control,
    // A DocumentFetcher whose every call either throttles or succeeds. Using
    // this seam (rather than a real server) keeps the schedule deterministic.
    fetcher: {
      id: "test",
      fetch: async () => {
        calls += 1;
        if (calls <= failures) {
          const headers: Record<string, string> = {};
          if (retryAfterMs !== undefined) {
            headers["retry-after"] = String(Math.round(retryAfterMs / 1000));
          }
          return {
            url: "https://shop.example.com/",
            finalUrl: "https://shop.example.com/",
            status: 429,
            headers,
            body: "",
            timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
            redirectChain: {
              sourceUrl: "https://shop.example.com/",
              finalUrl: "https://shop.example.com/",
              hops: [],
              chainLength: 0,
              isLoop: false,
              endsInError: false,
              httpsToHttp: false,
              httpToHttps: false,
            },
          };
        }
        return {
          url: "https://shop.example.com/",
          finalUrl: "https://shop.example.com/",
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><body>ok</body></html>",
          timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
          redirectChain: {
            sourceUrl: "https://shop.example.com/",
            finalUrl: "https://shop.example.com/",
            hops: [],
            chainLength: 0,
            isLoop: false,
            endsInError: false,
            httpsToHttp: false,
            httpToHttps: false,
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as FetchOptions["fetcher"],
  });
  return { options, calls: () => calls };
}

/** A fetch seam that always answers 404 — a successful fetch that is not 2xx. */
function notFoundFetcher() {
  const options = (control: RateLimitControl): FetchOptions => ({
    userAgent: "test",
    timeoutMs: 1_000,
    followRedirects: false,
    rateLimit: control,
    fetcher: {
      id: "test",
      fetch: async () => ({
        url: "https://shop.example.com/missing",
        finalUrl: "https://shop.example.com/missing",
        status: 404,
        headers: { "content-type": "text/html" },
        body: "<html><body>gone</body></html>",
        timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
        redirectChain: {
          sourceUrl: "https://shop.example.com/missing",
          finalUrl: "https://shop.example.com/missing",
          hops: [],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
      }),
    } as unknown as FetchOptions["fetcher"],
  });
  return { options };
}

/**
 * Run a fetch under Effect's TestClock so backoff sleeps resolve instantly and
 * the waits it asked for can be asserted exactly.
 */
async function runWithVirtualTime<A>(
  effect: Effect.Effect<A, CrawlError, never>,
): Promise<{ result: A | CrawlError; failed: boolean }> {
  const program = Effect.gen(function* () {
    // `Effect.either` first, so the fiber never dies and `join` hands back the
    // Either rather than an Exit that has to be destructured.
    const fiber = yield* Effect.fork(Effect.either(effect));
    // Far past any schedule these tests ask for. TestClock only moves time for
    // fibers that are actually sleeping, so a fetch that never backs off is
    // unaffected by the size of this jump.
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  });

  const outcome = await Effect.runPromise(program.pipe(Effect.provide(TestContext.TestContext)));
  return Either.isLeft(outcome)
    ? { result: outcome.left, failed: true }
    : { result: outcome.right, failed: false };
}

describe("fetchPageWithRetry rate-limit schedule (#1829)", () => {
  test("retries a throttled URL and reports each wait to the control", async () => {
    const { options, calls } = throttlingFetcher(3);
    const waits: number[] = [];
    const encounters: RateLimitEncounter[] = [];

    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: (encounter) => {
        encounters.push(encounter);
        // Mirror the production base/growth without jitter.
        return { waitMs: 5_000 * 2 ** (encounter.attempt - 1), exhausted: false };
      },
      onBackoff: ({ waitMs }) => waits.push(waitMs),
    };

    const { failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(false);
    expect(calls()).toBe(4);
    // First wait is at least 5s — the old schedule gave up after ~1.5s total.
    expect(waits).toEqual([5_000, 10_000, 20_000]);
    expect(encounters.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  test("a URL gets at least five retries while the cumulative wait fits the cap", async () => {
    const { options, calls } = throttlingFetcher(5);
    const waits: number[] = [];
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: ({ attempt }) => ({
        waitMs: 5_000 * 2 ** (attempt - 1),
        exhausted: false,
      }),
      onBackoff: ({ waitMs }) => waits.push(waitMs),
    };

    const { failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(false);
    expect(waits.length).toBe(5);
    expect(calls()).toBe(6);
    expect(calls()).toBe(RATE_LIMIT_MAX_ATTEMPTS);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(300_000);
  });

  test("Retry-After is honoured as the minimum wait", async () => {
    const { options } = throttlingFetcher(1, 7_000);
    const seen: (number | undefined)[] = [];
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: ({ retryAfterMs }) => {
        seen.push(retryAfterMs);
        return { waitMs: retryAfterMs ?? 5_000, exhausted: false };
      },
    };

    const { failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(false);
    expect(seen).toEqual([7_000]);
  });

  test("an exhausted host stops the retry loop immediately", async () => {
    const { options, calls } = throttlingFetcher(99);
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: () => ({ waitMs: 0, exhausted: true }),
    };

    const { result, failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(true);
    expect((result as CrawlError).type).toBe("rate_limit");
    // One attempt, then the host's verdict ends it — no five-wait schedule
    // per remaining URL once the host has given up.
    expect(calls()).toBe(1);
  });

  test("a wait longer than the remaining budget fails honestly instead of overrunning it", async () => {
    // Waiting past the per-URL watchdog would surface as "watchdog timeout",
    // blaming our own deadline for the origin's throttling.
    const { options, calls } = throttlingFetcher(99);
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: () => ({ waitMs: 120_000, exhausted: false }),
      remainingMs: () => 10_000,
    };

    const { result, failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(true);
    expect((result as CrawlError).type).toBe("rate_limit");
    expect(calls()).toBe(1);
  });

  test("the cumulative cap for one URL is enforced independently of the host", async () => {
    const { options } = throttlingFetcher(99);
    const waits: number[] = [];
    const control: RateLimitControl = {
      maxBackoffMs: 12_000,
      onRateLimited: () => ({ waitMs: 5_000, exhausted: false }),
      onBackoff: ({ waitMs }) => waits.push(waitMs),
    };

    const { failed } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(true);
    // 5s + 5s + the 2s that is left, then no budget remains.
    expect(waits).toEqual([5_000, 5_000, 2_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(12_000);
  });

  test("the FINAL refusal is still reported before the loop gives up", async () => {
    // The attempt cap used to be checked first, so the host registry never saw
    // the sixth refusal — its strike count and backoff budget under-counted on
    // exactly the URLs proving the host was throttling hardest.
    const { options } = throttlingFetcher(99);
    const attempts: number[] = [];
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onRateLimited: ({ attempt }) => {
        attempts.push(attempt);
        return { waitMs: 5_000, exhausted: false };
      },
    };

    await runWithVirtualTime(fetchPageWithRetry("https://shop.example.com/", options(control)));

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(attempts.length).toBe(RATE_LIMIT_MAX_ATTEMPTS);
  });

  test("only a 2xx counts toward recovery — a 404 does not", async () => {
    // applyStatusGuards lets most 4xx through as successful fetches, so
    // counting every `Right` handed a throttled host its concurrency back after
    // twenty 404s.
    const { options } = notFoundFetcher();
    let successes = 0;
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onSuccess: () => {
        successes += 1;
      },
    };

    const { failed, result } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/missing", options(control)),
    );

    expect(failed).toBe(false);
    expect((result as FetchResult).status).toBe(404);
    expect(successes).toBe(0);
  });

  test("a success tells the control the host is recovering", async () => {
    const { options } = throttlingFetcher(0);
    let successes = 0;
    const control: RateLimitControl = {
      maxBackoffMs: 300_000,
      onSuccess: () => {
        successes += 1;
      },
    };

    const { failed, result } = await runWithVirtualTime(
      fetchPageWithRetry("https://shop.example.com/", options(control)),
    );

    expect(failed).toBe(false);
    expect((result as FetchResult).status).toBe(200);
    expect(successes).toBe(1);
  });
});
