// #405 — the standard fetch path must honor fiber interruption (watchdog/stop)
// by forwarding the abort to the in-flight request. Without it a wedged socket
// parks uninterruptibly, processUrl's host-slot release never runs, and a
// single-origin crawl deadlocks. Here we prove an interrupt cancels promptly.

import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";

import { fetchPage } from "../src/fetcher";

const FETCH_OPTIONS = {
  userAgent: "test-agent",
  timeoutMs: 60_000, // long — the interrupt, not this, must end the request
  followRedirects: false,
};

describe("standard fetch interruptibility (#405)", () => {
  test("fiber interrupt aborts a wedged fetch instead of hanging", async () => {
    const original = globalThis.fetch;
    let sawAbort = false;
    // A fetch that never resolves on its own — only the forwarded abort ends it.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;

    try {
      const start = Date.now();
      // Effect.timeout interrupts the inner fiber — must propagate to the fetch.
      const result = await Effect.runPromise(
        fetchPage("https://example.com", FETCH_OPTIONS).pipe(
          Effect.timeout(Duration.millis(200)),
          Effect.either,
        ),
      );
      const elapsed = Date.now() - start;

      expect(sawAbort).toBe(true);
      expect(elapsed).toBeLessThan(2_000); // not the 60s fetch timeout
      // Timed out → Left (the interrupt won, the fetch did not return a page).
      expect(result._tag).toBe("Left");
    } finally {
      globalThis.fetch = original;
    }
  });
});
