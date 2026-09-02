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
import { checkExternalLinks } from "@/crawler/external-checker";
import { fetchScriptContents } from "@/crawler/script-fetcher";
import { closeGlobalContentStore } from "@/crawler/storage/content-store";
import { LinkCacheStorage } from "@/crawler/storage/link-cache";

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

    // The status is known from the headers; only the WAF verdict is lost, so
    // the link is reported as a plain 403 rather than as WAF-blocked.
    expect(results[0]?.status).toBe(403);
    expect(results[0]?.wafBlocked).toBeUndefined();
    expect(elapsed).toBeLessThan(DEADLINE_MS * 8);
  });
});
