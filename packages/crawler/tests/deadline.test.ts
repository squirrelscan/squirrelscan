// #1699 — a request deadline must cover the BODY read, not just the headers.
// The `fetch(...).finally(() => clearTimeout(t))` shape these helpers used to
// share disarmed the abort the moment the headers landed, so an origin that
// answered 200 and then stalled its body hung the caller forever.

import { describe, expect, test } from "bun:test";

import { safeFetchWithDeadline, withRequestDeadline } from "../src/deadline";

// Serves headers immediately, then holds the body stream open forever.
function serveStalledBody() {
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<!doctype html>"));
          // Never closed: the client is what has to give up.
        },
      });
      return new Response(stream, { headers: { "content-type": "text/html" } });
    },
  });
}

const DEADLINE_MS = 300;

describe("withRequestDeadline (#1699)", () => {
  test("a body that stalls after the headers aborts at the deadline", async () => {
    const server = serveStalledBody();
    let signal: AbortSignal | undefined;
    const startedAt = Date.now();
    try {
      const read = withRequestDeadline(
        DEADLINE_MS,
        (s) => {
          signal = s;
          return fetch(`http://localhost:${server.port}/`, { signal: s });
        },
        (response) => response.text(),
      );
      await expect(read).rejects.toThrow();
      const elapsed = Date.now() - startedAt;

      // It ended because the deadline fired, not because the origin relented.
      expect(signal?.aborted).toBe(true);
      // Close to the deadline, not merely "eventually": a bound that fires an
      // order of magnitude late is not a bound.
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS * 5);
    } finally {
      server.stop(true);
    }
  });

  test("a normal response is read in full and the deadline is disarmed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("hello", { headers: { "content-type": "text/plain" } }),
    });
    let signal: AbortSignal | undefined;
    try {
      const body = await withRequestDeadline(
        DEADLINE_MS,
        (s) => {
          signal = s;
          return fetch(`http://localhost:${server.port}/`, { signal: s });
        },
        (response) => response.text(),
      );
      expect(body).toBe("hello");

      // Wait out the deadline. Still un-aborted ⇒ the timer was cleared;
      // without the clearTimeout this flips to true here.
      await Bun.sleep(DEADLINE_MS * 2);
      expect(signal?.aborted).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("the signal is still armed while `use` runs, so a consumer can observe the expiry", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => new Response("body", { headers: { "content-type": "text/plain" } }),
    });
    try {
      // The deadline aborts the REQUEST, which is what unblocks a stalled body
      // read; it does not preempt unrelated work `use` chooses to do. What this
      // asserts is that the signal has not been disarmed by the time `use` runs.
      const aborted = await withRequestDeadline(
        200,
        (signal) => fetch(`http://localhost:${server.port}/`, { signal }).then((r) => {
          // Stash the signal the way a real consumer would observe it.
          (r as Response & { signal?: AbortSignal }).signal = signal;
          return r;
        }),
        async (response) => {
          const signal = (response as Response & { signal?: AbortSignal }).signal;
          await Bun.sleep(500);
          return signal?.aborted ?? false;
        },
      );
      expect(aborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("safeFetchWithDeadline (#1699)", () => {
  test("propagates the deadline through safeRedirectFetch into the body read", async () => {
    const server = serveStalledBody();
    const startedAt = Date.now();
    try {
      const read = safeFetchWithDeadline(
        `http://localhost:${server.port}/`,
        { headers: { "User-Agent": "squirrel-test" } },
        DEADLINE_MS,
        (response) => response.text(),
      );
      await expect(read).rejects.toThrow();
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS * 5);
    } finally {
      server.stop(true);
    }
  });
});
