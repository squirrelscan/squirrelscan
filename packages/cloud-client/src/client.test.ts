import { afterEach, describe, expect, test } from "bun:test";

import { createCloudClient } from "./client";
import { CloudClientError } from "./errors";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch stub that always throws a transport error, counting calls. */
function countingTransportFailure(): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("network down");
  }) as typeof fetch;
  return { calls: () => calls };
}

/**
 * Install a fetch stub that plays a script, one entry per attempt (last entry
 * repeats): a number replies that HTTP status; "throw" is a transport error;
 * "hang" waits for the per-attempt timeout to abort then rejects like real fetch.
 */
function scriptedFetch(steps: Array<number | "throw" | "hang">): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step === "throw") throw new TypeError("network down");
    if (step === "hang") {
      await new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        // Guard the already-aborted race so the listener can't be registered too late.
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort);
      });
    }
    return new Response(JSON.stringify({ balance: { total: 1 } }), {
      status: step as number,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls: () => calls };
}

describe("cloud-client transport retry", () => {
  test("render is sent AT MOST ONCE on transport failure (maxAttempts:1, no double-charge)", async () => {
    const probe = countingTransportFailure();
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      // Instance default would retry 3×; render must override to 1.
      maxAttempts: 3,
      // Keep the timeout signal from aborting the (synchronous) failures.
      timeoutMs: 10_000,
    });

    await expect(client.render({ urls: ["https://example.com/"] })).rejects.toBeInstanceOf(
      CloudClientError,
    );
    expect(probe.calls()).toBe(1);
  });

  test("an idempotent service still retries up to instance maxAttempts on transport failure", async () => {
    const probe = countingTransportFailure();
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 10_000,
    });

    await expect(client.deadLinks({ urls: ["https://example.com/"] })).rejects.toBeInstanceOf(
      CloudClientError,
    );
    // Proves the render pin doesn't leak into other methods.
    expect(probe.calls()).toBe(3);
  });
});

describe("cloud-client resilient reads (preflight bulletproofing)", () => {
  test("getBalance retries a transient 5xx and then succeeds", async () => {
    const probe = scriptedFetch([503, 200]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    await expect(client.getBalance()).resolves.toMatchObject({ balance: { total: 1 } });
    expect(probe.calls()).toBe(2);
  });

  test("getBalance surfaces the status after exhausting retries on a persistent 5xx", async () => {
    const probe = scriptedFetch([503, 503]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });
    const err = await client.getBalance().catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.status).toBe(503);
    expect(err.code).toBe("service_unavailable");
    expect(probe.calls()).toBe(2);
  });

  test("getBalance does NOT retry a terminal 4xx (401)", async () => {
    const probe = scriptedFetch([401]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 10_000,
    });
    const err = await client.getBalance().catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.code).toBe("not_authenticated");
    expect(probe.calls()).toBe(1);
  });

  test("a writer (POST) does NOT retry a transient HTTP 5xx — charge-on-submit safety", async () => {
    const probe = scriptedFetch([503]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 10_000,
    });
    const err = await client
      .siteMetadata({ url: "https://example.com", pages: [] })
      .catch((e) => e);
    expect(err.status).toBe(503);
    expect(probe.calls()).toBe(1);
  });

  test("getBalance does NOT retry a 429 (we don't honour Retry-After)", async () => {
    const probe = scriptedFetch([429]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 10_000,
    });
    const err = await client.getBalance().catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.status).toBe(429);
    expect(probe.calls()).toBe(1);
  });

  test("a timeout stays terminal for reads too — a hang can't inflate the worst case", async () => {
    const probe = scriptedFetch(["hang", 200]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 20,
    });
    await expect(client.getBalance()).rejects.toBeInstanceOf(CloudClientError);
    // Single attempt: the shared timeout aborts, no retry — bounds the wait at one timeoutMs.
    expect(probe.calls()).toBe(1);
  });

  test("a writer keeps the timeout terminal (no retry)", async () => {
    const probe = scriptedFetch(["hang", 200]);
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 2,
      timeoutMs: 20,
    });
    await expect(
      client.siteMetadata({ url: "https://example.com", pages: [] }),
    ).rejects.toBeInstanceOf(CloudClientError);
    expect(probe.calls()).toBe(1);
  });
});

describe("cloud-client siteMetadata", () => {
  test("POSTs the request to /v1/services/metadata and returns the parsed profile", async () => {
    let seenUrl: string | undefined;
    let seenBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          siteType: "blog",
          isYMYL: false,
          isLocalBusiness: false,
          hasOwnershipVerified: false,
          confidence: "high",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = createCloudClient({ apiUrl: "https://api.test", token: "sqcli_x" });
    const res = await client.siteMetadata({
      auditId: "audit-1",
      url: "https://example.com",
      pages: [{ url: "https://example.com/", title: "Home" }],
    });

    expect(seenUrl).toBe("https://api.test/v1/services/metadata");
    expect(seenBody).toMatchObject({ url: "https://example.com" });
    expect(res.siteType).toBe("blog");
    expect(res.confidence).toBe("high");
  });

  test("is idempotent: retries up to instance maxAttempts on transport failure", async () => {
    const probe = countingTransportFailure();
    const client = createCloudClient({
      apiUrl: "https://api.test",
      token: "sqcli_x",
      maxAttempts: 3,
      timeoutMs: 10_000,
    });

    await expect(
      client.siteMetadata({ url: "https://example.com", pages: [] }),
    ).rejects.toBeInstanceOf(CloudClientError);
    expect(probe.calls()).toBe(3);
  });
});

describe("cloud-client 402 error parsing (#214 envelope)", () => {
  /** Reply 402 once with the given JSON body. */
  function reply402(body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  test("reads `required` from the typed envelope `{ error: { required } }`", async () => {
    reply402({
      error: { code: "INSUFFICIENT_CREDITS", message: "Insufficient credits", required: 7 },
    });
    const client = createCloudClient({ apiUrl: "https://api.test", token: "sqcli_x" });
    const err = await client
      .siteMetadata({ url: "https://example.com", pages: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.code).toBe("insufficient_credits"); // derived from 402 status
    expect(err.status).toBe(402);
    expect(err.required).toBe(7);
  });

  test("ignores a legacy top-level `required` — envelope-only after #214 rollout (#377)", async () => {
    reply402({ error: "insufficient_credits", required: 5 });
    const client = createCloudClient({ apiUrl: "https://api.test", token: "sqcli_x" });
    const err = await client
      .siteMetadata({ url: "https://example.com", pages: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.status).toBe(402);
    expect(err.required).toBeUndefined();
  });
});

describe("cloud-client 409 code split — RUN_NOT_ACTIVE vs DUPLICATE_REQUEST (#475)", () => {
  function reply409(code: string) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code, message: "x" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  }

  test("RUN_NOT_ACTIVE → run_inactive (reaped run, NOT a replay)", async () => {
    reply409("RUN_NOT_ACTIVE");
    const client = createCloudClient({ apiUrl: "https://api.test", token: "sqcli_x" });
    const err = await client
      .siteMetadata({ url: "https://example.com", pages: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.code).toBe("run_inactive");
    expect(err.status).toBe(409);
  });

  test("DUPLICATE_REQUEST → duplicate_request (unchanged status-derived mapping)", async () => {
    reply409("DUPLICATE_REQUEST");
    const client = createCloudClient({ apiUrl: "https://api.test", token: "sqcli_x" });
    const err = await client
      .siteMetadata({ url: "https://example.com", pages: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CloudClientError);
    expect(err.code).toBe("duplicate_request");
    expect(err.status).toBe(409);
  });
});

describe("cloud-client stalled response body (#1214)", () => {
  // Real local server (not a fetch stub) so the ACTUAL runtime body-read path is
  // exercised: headers land immediately, the body stream never finishes — the
  // wedge that hung run 01KXYKKYMM for 52min past every client bound. The
  // per-request timeout must bound the WHOLE lifecycle including the body read.
  function stallingServer(status: number): { url: string; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            // Partial JSON, then silence — never closed, never errored.
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        });
        return new Response(stream, {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  }

  test("a 200 whose body never completes rejects within timeoutMs, not hangs", async () => {
    const server = stallingServer(200);
    try {
      const client = createCloudClient({
        apiUrl: server.url,
        token: "sqcli_x",
        timeoutMs: 250,
        maxAttempts: 1,
      });
      const started = Date.now();
      const err = await client
        .domainStats({ auditId: "a1", url: "https://example.com" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(CloudClientError);
      // Bounded by timeoutMs (+slack), not the never-ending stream — proves no hang.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.stop();
    }
  });

  test("an error status whose body never completes still surfaces the status, bounded", async () => {
    const server = stallingServer(500);
    try {
      const client = createCloudClient({
        apiUrl: server.url,
        token: "sqcli_x",
        timeoutMs: 250,
        maxAttempts: 1,
      });
      const started = Date.now();
      const err = await client
        .editorSummary({ auditId: "a1", url: "https://example.com", categories: [], issues: [] })
        .catch((e) => e);
      expect(err).toBeInstanceOf(CloudClientError);
      // The stalled error body degrades to undefined; the status-derived code survives.
      expect(err.status).toBe(500);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.stop();
    }
  });

  test("a retryable 500 whose body stalls is retried + bounded (default maxAttempts)", async () => {
    // The retry path is the gap the maxAttempts:1 tests miss (#1233): an idempotent
    // read retries a 500, but each abandoned response body also stalls. Without
    // cancelling it before backoff, every retry leaks a held-open socket outside
    // the per-request bound. The whole retry loop must stay bounded and surface a
    // CloudClientError, and the retries must actually happen over the stalled bodies.
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requestCount++;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        });
        return new Response(stream, { status: 500, headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      // getBalance is the idempotent read that retries transient 5xx; default
      // maxAttempts (3) so the retry-and-cancel path runs more than once.
      const client = createCloudClient({
        apiUrl: `http://localhost:${server.port}`,
        token: "sqcli_x",
        timeoutMs: 2_500,
      });
      const started = Date.now();
      const err = await client.getBalance().catch((e) => e);
      expect(err).toBeInstanceOf(CloudClientError);
      // Bounded despite N stalled bodies across retries — proves no per-retry leak hangs the loop.
      expect(Date.now() - started).toBeLessThan(8_000);
      // The stalled bodies didn't short-circuit the retry loop into one attempt.
      expect(requestCount).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });
});
