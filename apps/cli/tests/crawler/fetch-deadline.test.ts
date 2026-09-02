// #1729 — a request deadline must cover the BODY read, not just the headers.
//
// apps/cli/src/crawler/{script-fetcher,external-checker}.ts are FORKS of the
// audit-engine fetchers, not re-exports, so the engine's regression test proves
// nothing about them — and these forks are what the `squirrel` CLI actually
// runs. Each of the three fetchers here cleared its timer where the response
// resolved, i.e. when the HEADERS landed, leaving the body read with no time
// bound at all. Sitemaps stall the crawl preamble; scripts and external links
// are fetched during rules enrichment, after the crawl, so an origin that
// answered 200 and then stalled its body gave an audit that had all its pages
// and never finished.

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchSitemap } from "@/crawl/sitemaps";
import {
  checkExternalLinks,
  filterBrokenLinks,
  filterWafBlockedLinks,
} from "@/crawler/external-checker";
import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { LinkCacheStorage } from "@/crawler/storage/link-cache";

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

    // The external checker probes with HEAD first. Answer it with the status
    // and no body so the stall below is reached on the GET, which is the read
    // this regression is about.
    if (req.method === "HEAD") {
      return new Response(null, {
        status: path.startsWith("/stall-403") ? 403 : 200,
      });
    }

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
    if (path === "/stall-403") {
      // A 403 is what sends the external checker into its WAF body read. No WAF
      // headers here: the body is the ONLY evidence available.
      return new Response(stall, {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    if (path === "/stall-403-cf") {
      // Same stalled body, but the headers alone identify the WAF.
      return new Response(stall, {
        status: 403,
        headers: {
          "content-type": "text/html",
          "cf-ray": "8a1b2c3d4e5f6789-SYD",
        },
      });
    }
    if (path === "/stall-sitemap.xml") {
      return new Response(stall, {
        headers: { "content-type": "application/xml" },
      });
    }
    if (path === "/fast.js") {
      return new Response("console.log(1);", {
        headers: { "content-type": "application/javascript" },
      });
    }
    if (path === "/missing.xml") {
      return new Response("nope", { status: 404 });
    }
    if (path === "/sitemap.xml") {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/one</loc></url>
</urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }
    return new Response("ok", { headers: { "content-type": "text/plain" } });
  },
});

const base = `http://localhost:${server.port}`;

// Throwaway stores so neither fetcher touches the user's real caches, and so a
// stale entry can never satisfy a request under test.
const cacheDir = mkdtempSync(join(tmpdir(), "squirrel-deadline-"));
const priorContentStorePath = process.env.SQUIRREL_CONTENT_STORE_PATH;
process.env.SQUIRREL_CONTENT_STORE_PATH = join(cacheDir, "content.db");
const linkCache = new LinkCacheStorage(join(cacheDir, "links.db"));

afterAll(() => {
  server.stop(true);
  linkCache.close();
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

describe("CLI sitemap fetcher deadline (#1729)", () => {
  test("a sitemap body that stalls after the headers times out", async () => {
    const startedAt = Date.now();
    const result = await Effect.runPromise(
      fetchSitemap(`${base}/stall-sitemap.xml`, "test-agent", DEADLINE_MS)
    );
    const elapsed = Date.now() - startedAt;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });

  test("a sitemap that answers promptly is still parsed", async () => {
    const result = await Effect.runPromise(
      fetchSitemap(`${base}/sitemap.xml`, "test-agent", DEADLINE_MS)
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.urls.length).toBeGreaterThan(0);
    }
  });

  test("each failure keeps its own reason instead of collapsing to one string", async () => {
    // A body-deadline abort, an HTTP error and a connect failure used to be
    // indistinguishable in the failed-sitemap report: every non-HTTP failure
    // collapsed to a bare "Unexpected error".
    const stalled = await Effect.runPromise(
      fetchSitemap(`${base}/stall-sitemap.xml`, "test-agent", DEADLINE_MS)
    );
    const notFound = await Effect.runPromise(
      fetchSitemap(`${base}/missing.xml`, "test-agent", DEADLINE_MS)
    );

    // The connect failure is injected rather than aimed at an unresolvable
    // host: real DNS can outrun a short deadline, in which case the abort wins
    // the race and the run reports a timeout — correctly, but it proves nothing
    // about the connect path.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError("connection refused"))) as typeof fetch;
    let unreachable;
    try {
      unreachable = await Effect.runPromise(
        fetchSitemap(`${base}/sitemap.xml`, "test-agent", DEADLINE_MS)
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(stalled.success).toBe(false);
    expect(notFound.success).toBe(false);
    expect(unreachable.success).toBe(false);
    if (stalled.success || notFound.success || unreachable.success) return;

    expect(stalled.error).toContain("Timed out");
    expect(notFound.error).toBe("HTTP 404");
    expect(unreachable.error).toBe("connection refused");
    // None of the three collapse into the old catch-all.
    expect(
      new Set([stalled.error, notFound.error, unreachable.error]).size
    ).toBe(3);
  });
});

describe("CLI external checker deadline (#1729)", () => {
  test("a 403 whose body stalls does not hang the WAF read", async () => {
    const startedAt = Date.now();
    const results = await Effect.runPromise(
      checkExternalLinks([`${base}/stall-403`], linkCache, {
        timeoutMs: DEADLINE_MS,
      })
    );
    const elapsed = Date.now() - startedAt;

    // The status is known from the headers. With no WAF signature in the
    // headers and no body to read, this stays a plain 403 - the pre-existing
    // ambiguity, unchanged by this fix.
    expect(results[0]?.status).toBe(403);
    expect(results[0]?.wafBlocked).toBeUndefined();
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });

  test("an unreadable 403 body still gets WAF detection from the headers", async () => {
    const results = await Effect.runPromise(
      checkExternalLinks([`${base}/stall-403-cf`], linkCache, {
        timeoutMs: DEADLINE_MS,
      })
    );

    // The deadline now cuts the WAF body read short, so giving up on detection
    // there would report a live, bot-guarded link as broken. Headers are
    // evidence in their own right: detection runs on them regardless.
    expect(results[0]?.status).toBe(403);
    expect(results[0]?.wafBlocked).toBe(true);
    expect(results[0]?.wafProvider).toBe("cloudflare");
    expect(filterBrokenLinks(results)).toEqual([]);
    expect(filterWafBlockedLinks(results).length).toBe(1);
  });
});
