// #1729 — a request deadline must cover the BODY read, not just the headers.
//
// apps/cli/src/crawler/script-fetcher.ts is a FORK of the audit-engine script
// fetcher, not a re-export, so the engine's regression test proves nothing
// about it, and the CLI's analyze pass runs it. It cleared its timer where the
// response resolved, i.e. when the HEADERS landed, leaving the body read with
// no time bound at all. Scripts are fetched during rules enrichment, after the
// crawl, so an origin that answered 200 and then stalled its body gave an
// audit that had all its pages and never finished. (With the forks' removal,
// #756, the sitemap cases moved to the crawler's tests, and the external link
// cases were dropped: the engine's fetch-deadline test covers them.)

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";

const DEADLINE_MS = 300;
/** SCRIPT_FETCH_LIMITS.RETRY_DELAY_MS * 2^0 - the first (and only) backoff. */
const RETRY_BACKOFF_MS = 1000;

// Headers land immediately; the body stream is enqueued once and never closed,
// so only the client can end the request.
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;

    const stall = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("// first chunk\n"));
      },
    });

    if (path === "/stall.js") {
      return new Response(stall, {
        headers: { "content-type": "application/javascript" },
      });
    }
    if (path === "/fast.js") {
      return new Response("console.log(1);", {
        headers: { "content-type": "application/javascript" },
      });
    }
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  },
});

const base = `http://localhost:${server.port}`;

// A throwaway content store so the fetcher never touches the user's real
// cache, and a stale entry can never satisfy a request under test.
const cacheDir = mkdtempSync(join(tmpdir(), "squirrel-deadline-"));
const priorContentStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
process.env.SQUIRREL_CONTENT_STORE_PATH = join(cacheDir, "content.db");

afterAll(() => {
  server.stop(true);
  closeGlobalContentStore();
  // Restore the env, or the next test file in this process gets a store path
  // pointing at the directory removed below.
  if (priorContentStorePath === undefined) {
    delete process.env.SQUIRREL_CONTENT_STORE_PATH;
  } else {
    process.env.SQUIRREL_CONTENT_STORE_PATH = priorContentStorePath;
  }
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("CLI script fetcher deadline (#1729)", () => {
  test("a script body that stalls after the headers times out", async () => {
    const startedAt = Date.now();
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/stall.js`], { timeoutMs: DEADLINE_MS })
    );
    const elapsed = Date.now() - startedAt;

    expect(result?.error).toBe("timeout");
    expect(result?.content).toBe(null);
    // Close to the deadline, not merely "eventually": a bound that fires an
    // order of magnitude late is not a bound. Before the fix this never
    // returned at all.
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });

  test("a script that answers promptly is still read in full", async () => {
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/fast.js`], { timeoutMs: DEADLINE_MS })
    );

    expect(result?.error).toBe(null);
    expect(result?.status).toBe(200);
    expect(result?.content).toBe("console.log(1);");
  });
});

describe("CLI script fetcher retry deadline (#1729)", () => {
  // The retry loop moved OUT of the attempt so each attempt arms its own
  // controller and timer. One deadline spanning the whole retry sequence would
  // hand attempt 2 an already-expired abort.
  test("attempt 2 gets a fresh deadline, not the spent one", async () => {
    const realFetch = globalThis.fetch;
    let attempts = 0;
    // Attempt 1 fails at connect — a transient network error, NOT an abort, so
    // it takes the retry path. (A server-side stream error will not do: Bun
    // delivers it to the client as a clean end-of-stream, which reads as an
    // empty body and never retries.)
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1)
        return Promise.reject(new TypeError("connection reset"));
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const startedAt = Date.now();
      // Attempt 2 hits the STALLED script, so its own deadline is what has to
      // end the run. Three things are pinned at once: a retry happened, the
      // retry's deadline covers its BODY read (an unbounded one hangs here),
      // and that deadline is fresh - a spent timer or an already-aborted
      // controller would fail attempt 2 instantly, at ~backoff rather than
      // ~backoff + deadline.
      const [result] = await Effect.runPromise(
        fetchScriptContents([`${base}/stall.js`], { timeoutMs: DEADLINE_MS })
      );
      const elapsed = Date.now() - startedAt;

      expect(attempts).toBe(2);
      expect(result?.error).toBe("timeout");
      expect(elapsed).toBeGreaterThanOrEqual(
        RETRY_BACKOFF_MS + DEADLINE_MS - 100
      );
      expect(elapsed).toBeLessThan(RETRY_BACKOFF_MS + DEADLINE_MS * 8);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 15_000);
});
