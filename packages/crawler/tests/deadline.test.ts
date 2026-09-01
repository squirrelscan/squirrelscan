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

describe("withRequestDeadline (#1699)", () => {
  test("a body that stalls after the headers aborts at the deadline", async () => {
    const server = serveStalledBody();
    const startedAt = Date.now();
    try {
      const read = withRequestDeadline(
        300,
        (signal) => fetch(`http://localhost:${server.port}/`, { signal }),
        (response) => response.text(),
      );
      expect(read).rejects.toThrow();
      await read.catch(() => {});
      // Bounded by the deadline, not by the origin eventually relenting.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      server.stop(true);
    }
  });

  test("a normal response is read in full and the deadline does not fire", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("hello", { headers: { "content-type": "text/plain" } }),
    });
    try {
      const body = await withRequestDeadline(
        5_000,
        (signal) => fetch(`http://localhost:${server.port}/`, { signal }),
        (response) => response.text(),
      );
      expect(body).toBe("hello");
    } finally {
      server.stop(true);
    }
  });

  test("the deadline covers work `use` does after the headers, not just the fetch", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => new Response("body", { headers: { "content-type": "text/plain" } }),
    });
    try {
      // `use` observes an already-armed signal, so a slow consumer is bounded too.
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
        300,
        (response) => response.text(),
      );
      expect(read).rejects.toThrow();
      await read.catch(() => {});
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      server.stop(true);
    }
  });
});
