// #1729 — the standard fetch path's deadline must cover the BODY read.
//
// `requestWithTiming` cleared its timer in a `finally` that closed at the fetch,
// and the Response escaped to be read much later in `fetchPageStandard`. That is
// the same clear-at-headers bug as #1699, wearing a `try/finally` that looks
// correct: `fetch` settles when the HEADERS land, so a 200 followed by a stalled
// body had no bound from `timeoutMs` at all. It was not an unbounded hang — the
// per-URL watchdog in crawler.ts (>= 120s) is the backstop — but a stalled page
// burned the whole watchdog instead of `timeoutMs`, and because the same
// `finally` also removed the interrupt bridge, the watchdog's abort never
// reached the reader: `readBodyCapped` stayed parked on `reader.read()` for the
// life of the process, holding the socket and its buffered chunks.

import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";

import { fetchPage } from "../src/fetcher";

const DEADLINE_MS = 400;

const FETCH_OPTIONS = {
  userAgent: "squirrel-test",
  timeoutMs: DEADLINE_MS,
  followRedirects: true,
};

/**
 * Headers land at once; the body emits one chunk and then never closes.
 *
 * `seen.aborted` records whether the CLIENT actually cancelled the request,
 * which is the half of this bug that ending the fiber does not prove: the old
 * code lost the race and abandoned the fiber while `readBodyCapped` stayed
 * parked on the socket.
 */
function serveStalledBody(seen: { aborted: boolean }): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => {
        seen.aborted = true;
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<!doctype html><html><body>"));
          // Never closed: only the client can end this.
        },
      });
      return new Response(stream, { headers: { "content-type": "text/html" } });
    },
  });
}

/** Give the runtime a moment to propagate a socket close to the server. */
async function settle(ms = 500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("standard fetch body deadline (#1729)", () => {
  test("a body that stalls after the headers fails at timeoutMs, not the watchdog", async () => {
    const seen = { aborted: false };
    const server = serveStalledBody(seen);
    try {
      const startedAt = Date.now();
      const result = await Effect.runPromise(
        Effect.either(fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS)),
      );
      const elapsed = Date.now() - startedAt;

      // The request deadline ended it, and it is reported as a timeout rather
      // than as a malformed response.
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.type).toBe("timeout");

      // Close to timeoutMs. Before the fix nothing here fired at all: the read
      // parked until the caller's own watchdog interrupted it.
      expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(DEADLINE_MS * 8);

      // The socket was released, not merely abandoned.
      await settle();
      expect(seen.aborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a fiber interrupt during the body read cancels the request, not just the fiber", async () => {
    const seen = { aborted: false };
    const server = serveStalledBody(seen);
    try {
      const startedAt = Date.now();
      // A deadline far longer than the interrupt, so only the interrupt can end
      // this. Ending the FIBER was never the hard part — the old code won that
      // race too. What it did not do was cancel the underlying read, because
      // the interrupt bridge had already been unhooked when the headers landed.
      const result = await Effect.runPromise(
        fetchPage(`http://localhost:${server.port}/`, {
          ...FETCH_OPTIONS,
          timeoutMs: 60_000,
        }).pipe(Effect.timeout(Duration.millis(300)), Effect.either),
      );
      const elapsed = Date.now() - startedAt;

      expect(result._tag).toBe("Left");
      expect(elapsed).toBeLessThan(5_000);

      await settle();
      expect(seen.aborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a normal body is still read in full and the deadline is released", async () => {
    const body = "<!doctype html><html><head><title>ok</title></head><body>hi</body></html>";
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(body, { headers: { "content-type": "text/html" } }),
    });
    try {
      const result = await Effect.runPromise(
        fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS),
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe(body);
    } finally {
      server.stop(true);
    }
  });

  test("a redirect chain still resolves once the abandoned hops are dropped", async () => {
    // The loop now aborts each superseded hop. The final response must survive
    // that, and the chain must still be recorded.
    const body = "<!doctype html><html><head><title>done</title></head><body>x</body></html>";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/") return new Response(null, { status: 301, headers: { location: "/a" } });
        if (path === "/a") return new Response(null, { status: 302, headers: { location: "/b" } });
        return new Response(body, { headers: { "content-type": "text/html" } });
      },
    });
    try {
      const result = await Effect.runPromise(
        fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS),
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe(body);
      expect(result.finalUrl).toBe(`http://localhost:${server.port}/b`);
      expect(result.redirectChain.hops.length).toBe(3);
    } finally {
      server.stop(true);
    }
  });
});
