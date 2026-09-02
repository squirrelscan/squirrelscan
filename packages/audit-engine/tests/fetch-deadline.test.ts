// #1729 — a request deadline must cover the BODY read, not just the headers.
//
// Both fetchers here cleared their timer where the response resolved, i.e. when
// the HEADERS landed. `readBodyCapped` caps BYTES, not seconds, so an origin
// that answered 200 and then stalled its body left the read with no bound at
// all. Scripts and external links are fetched during rules enrichment, after
// the crawl, so the audit had all its pages and simply never finished.

import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { checkExternalLinks } from "../src/external-checker";
import { fetchScriptContents } from "../src/script-fetcher";

const DEADLINE_MS = 300;

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
      return new Response(null, { status: path === "/stall-403" ? 403 : 200 });
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
      // A 403 is what sends the external checker into its WAF body read.
      return new Response(stall, {
        status: 403,
        headers: { "content-type": "text/html" },
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

afterAll(() => {
  server.stop(true);
});

describe("script fetcher deadline (#1729)", () => {
  test("a script body that stalls after the headers times out", async () => {
    const startedAt = Date.now();
    const [result] = await Effect.runPromise(
      fetchScriptContents([`${base}/stall.js`], { timeoutMs: DEADLINE_MS }),
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
      fetchScriptContents([`${base}/fast.js`], { timeoutMs: DEADLINE_MS }),
    );

    expect(result?.error).toBe(null);
    expect(result?.status).toBe(200);
    expect(result?.content).toBe("console.log(1);");
  });
});

describe("external checker deadline (#1729)", () => {
  test("a 403 whose body stalls does not hang the WAF read", async () => {
    const startedAt = Date.now();
    const results = await Effect.runPromise(
      checkExternalLinks([`${base}/stall-403`], null, {
        timeoutMs: DEADLINE_MS,
      }),
    );
    const elapsed = Date.now() - startedAt;

    // The status is known from the headers; only the WAF verdict is lost, so
    // the link is reported as a plain 403 rather than as WAF-blocked.
    expect(results[0]?.status).toBe(403);
    expect(results[0]?.wafBlocked).toBeUndefined();
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });
});
