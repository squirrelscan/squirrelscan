// squirrelscan/repo#2026 — the cloud fetcher's deadline structure. Each
// request's `timeoutMs` is the OUTER deadline of the whole fetch; render has
// `outer - headroom` to itself, then the plain fallback starts with the
// remaining headroom and races it. The class fix under #1699: a caller that
// enforces the outer deadline used to abort the waiter before the fallback
// ever dispatched, because render ran under a 45s batch budget of its own.
//
// Synthetic origins only (egress is blocked in the harness). Deadlines are a
// few hundred ms so the structure fires the way it does in production, faster.

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import type { CloudServicesClient } from "@squirrelscan/cloud-client";
import type { RenderChargeLine, RenderRequest } from "@squirrelscan/core-contracts";
import { createCrawler, type CrawlerConfig, type CrawlerEvent } from "@squirrelscan/crawler";
import {
  createFetchDocumentFetcher,
  type DocumentFetcher,
  type FetchRequest,
  type FetchResponse,
} from "@squirrelscan/fetchers";

import { createCloudDocumentFetcher } from "../src/cloud-fetcher";

const OUTER_MS = 400;
// Headroom is clamped to half the outer, so at 400ms the fallback starts at 200ms.
const HEADROOM_MS = 200;

const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A Bun origin answering 200 HTML on every path after `ttfbMs`. */
function serveOrigin(ttfbMs: number): { url: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (ttfbMs > 0) await Bun.sleep(ttfbMs);
      return new Response(
        `<!doctype html><html><head><title>${path}</title></head><body><a href="/one">one</a><a href="/two">two</a><p>plain</p></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/`, hits };
}

/** A render whose job never turns terminal — the "render never returns" shape. */
function neverReturningClient(charged = 2): CloudServicesClient {
  return {
    render: async () => ({ jobId: "job-1", status: "queued" as const, charged }),
    renderResult: async (jobId: string) => ({ jobId, status: "running" as const }),
  } as unknown as CloudServicesClient;
}

/** A recording fallback that answers `body` after `delayMs` (or throws `error`). */
function fallbackFetcher(opts: { delayMs?: number; body?: string; error?: Error } = {}) {
  const requests: FetchRequest[] = [];
  const fetcher: DocumentFetcher = {
    id: "fallback",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req): Promise<FetchResponse> {
      requests.push(req);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.error) throw opts.error;
      return {
        url: req.url,
        finalUrl: req.url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: opts.body ?? "fallback",
        timing: { startedAt: 0, responseAt: 1, finishedAt: 1 },
        redirectChain: {
          sourceUrl: req.url,
          finalUrl: req.url,
          hops: [{ url: req.url, statusCode: 200, type: "http" as const }],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
        fetcherMethod: "fetch",
      };
    },
  };
  return { fetcher, requests };
}

const fastPolling = { batchWindowMs: 1, firstPollDelayMs: 5, pollIntervalMs: 20 };
const URL_A = "https://example.com/a";

describe("fallback headroom inside the outer deadline (#2026)", () => {
  test("a render that never returns + a plain origin inside the headroom: the page lands, no abort surfaces", async () => {
    const origin = serveOrigin(20);
    const fetcher = createCloudDocumentFetcher(neverReturningClient(), {
      ...fastPolling,
      fallback: createFetchDocumentFetcher(),
      // A batch budget far past the outer deadline, as in production (45s vs
      // a 30s page): the request's own deadline must be what bounds the fetch.
      timeoutMs: 10_000,
    });

    const startedAt = Date.now();
    // The caller enforces the outer deadline too, the way the crawler's
    // watchdog does — before the fix this abort landed first and the page was
    // lost as "The operation was aborted."
    const resp = await fetcher.fetch({
      url: origin.url,
      timeoutMs: OUTER_MS,
      signal: AbortSignal.timeout(OUTER_MS),
    });
    const elapsed = Date.now() - startedAt;

    expect(resp.status).toBe(200);
    expect(resp.fetcherMethod).toBe("fetch");
    expect(resp.body).toContain("<p>plain</p>");
    expect(origin.hits).toEqual(["/"]);
    // Landed inside the outer deadline, after the render's exclusive share.
    expect(elapsed).toBeLessThan(OUTER_MS);
    expect(elapsed).toBeGreaterThanOrEqual(HEADROOM_MS - 20);
  });

  test("the fallback gets what is LEFT of the outer deadline, never the request's full timeout again", async () => {
    // Render fails at once → the fallback starts early with (almost) the whole
    // outer deadline; a racing fallback starts at outer - headroom with the
    // headroom. Neither is handed `timeoutMs` = outer a second time.
    const early = fallbackFetcher();
    const failingClient = {
      render: async () => ({ jobId: "job-1", status: "queued" as const, charged: 2 }),
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: URL_A, status: null, error: "render failed" }],
      }),
    } as unknown as CloudServicesClient;
    await createCloudDocumentFetcher(failingClient, { ...fastPolling, fallback: early.fetcher }).fetch(
      { url: URL_A, timeoutMs: OUTER_MS },
    );
    expect(early.requests).toHaveLength(1);
    expect(early.requests[0]!.timeoutMs).toBeLessThanOrEqual(OUTER_MS);
    expect(early.requests[0]!.timeoutMs).toBeGreaterThan(OUTER_MS - 100);

    const racing = fallbackFetcher();
    await createCloudDocumentFetcher(neverReturningClient(), {
      ...fastPolling,
      fallback: racing.fetcher,
    }).fetch({ url: URL_A, timeoutMs: OUTER_MS });
    expect(racing.requests).toHaveLength(1);
    expect(racing.requests[0]!.timeoutMs).toBeLessThanOrEqual(HEADROOM_MS);
    expect(racing.requests[0]!.timeoutMs).toBeGreaterThan(HEADROOM_MS - 60);
  });

  test("a render that lands during the race, inside the deadline, still wins: paid work is used", async () => {
    // Fallback starts at 200ms and needs 150ms more; the render turns done at
    // ~260ms. The rendered page must be the one served, with ONE charge and
    // the fallback's late answer discarded.
    const fallback = fallbackFetcher({ delayMs: 150 });
    const startedAt = Date.now();
    const client = {
      render: async () => ({ jobId: "job-1", status: "queued" as const, charged: 2 }),
      renderResult: async (jobId: string) =>
        Date.now() - startedAt < 260
          ? { jobId, status: "running" as const }
          : {
              jobId,
              status: "done" as const,
              results: [{ url: URL_A, status: 200, html: "<html>rendered</html>", headers: {} }],
            },
    } as unknown as CloudServicesClient;
    const charges: Array<[number, number]> = [];
    const fetcher = createCloudDocumentFetcher(client, {
      ...fastPolling,
      fallback: fallback.fetcher,
      onRenderCharged: (units, credits) => charges.push([units, credits]),
    });

    const resp = await fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS });

    expect(resp.fetcherMethod).toBe("cloud-render");
    expect(resp.body).toBe("<html>rendered</html>");
    // The race did start (the fallback was dispatched at the headroom mark)…
    expect(fallback.requests).toHaveLength(1);
    // …and exactly one render was charged for the page.
    expect(charges).toEqual([[1, 2]]);
  });

  test("a racing fallback that fails fast does not throw a render away that lands inside the deadline", async () => {
    const fallback = fallbackFetcher({ error: new Error("connection refused") });
    const startedAt = Date.now();
    const client = {
      render: async () => ({ jobId: "job-1", status: "queued" as const, charged: 2 }),
      renderResult: async (jobId: string) =>
        Date.now() - startedAt < 300
          ? { jobId, status: "running" as const }
          : {
              jobId,
              status: "done" as const,
              results: [{ url: URL_A, status: 200, html: "<html>late render</html>", headers: {} }],
            },
    } as unknown as CloudServicesClient;
    const fetcher = createCloudDocumentFetcher(client, { ...fastPolling, fallback: fallback.fetcher });

    const resp = await fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS });

    expect(fallback.requests).toHaveLength(1);
    expect(resp.body).toBe("<html>late render</html>");
  });

  test("neither lands by the outer deadline: the fetch fails with the fallback's error, once, at the deadline", async () => {
    const fallback = fallbackFetcher({ error: new Error("connection refused") });
    const fetcher = createCloudDocumentFetcher(neverReturningClient(), {
      ...fastPolling,
      fallback: fallback.fetcher,
    });
    const startedAt = Date.now();
    await expect(fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS })).rejects.toThrow(
      "connection refused",
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(OUTER_MS - 20);
    expect(elapsed).toBeLessThan(OUTER_MS + 300);
    expect(fallback.requests).toHaveLength(1);
  });

  test("a per-url render error arriving after the race started does not start a second fallback", async () => {
    const fallback = fallbackFetcher({ delayMs: 120 });
    const startedAt = Date.now();
    const client = {
      render: async () => ({ jobId: "job-1", status: "queued" as const, charged: 2 }),
      renderResult: async (jobId: string) =>
        Date.now() - startedAt < 260
          ? { jobId, status: "running" as const }
          : {
              jobId,
              status: "done" as const,
              results: [{ url: URL_A, status: null, error: "render failed" }],
            },
    } as unknown as CloudServicesClient;
    const fetcher = createCloudDocumentFetcher(client, { ...fastPolling, fallback: fallback.fetcher });

    const resp = await fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS });

    expect(resp.body).toBe("fallback");
    expect(fallback.requests).toHaveLength(1);
  });
});

describe("the charge path is abort-aware (#2026)", () => {
  test("a caller abort during the submit no longer cancels it: the server's debit is still recorded", async () => {
    // Before: the submit ran under the batch's abort signal, so a caller abort
    // (crawl stop / watchdog) mid-submit cancelled the HTTP call, the server
    // had already debited on submit, and nothing recorded it — onRenderCharged
    // never fired and `budget.spent` stayed short by a batch. Run against the
    // old fetcher this test fails on both charge assertions.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const submitted: RenderRequest[] = [];
    const client = {
      render: async (req: RenderRequest, opts?: { signal?: AbortSignal }) => {
        submitted.push(req);
        await gate;
        // The real client rejects when its signal aborts; the old code passed
        // the callers' abort through here.
        if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        return { jobId: "job-1", status: "queued" as const, charged: 2 };
      },
      renderResult: async (jobId: string) => ({ jobId, status: "running" as const }),
    } as unknown as CloudServicesClient;
    const charges: Array<{ units: number; credits: number; breakdown: RenderChargeLine[] }> = [];
    const budget = { spent: 0, cap: 100 };
    const fallback = fallbackFetcher();
    const fetcher = createCloudDocumentFetcher(client, {
      ...fastPolling,
      fallback: fallback.fetcher,
      budget,
      onRenderCharged: (units, credits, breakdown) => charges.push({ units, credits, breakdown }),
    });

    const ctrl = new AbortController();
    const pending = fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS, signal: ctrl.signal });
    // Wait for the submit to be in flight, then abort the caller.
    while (submitted.length === 0) await Bun.sleep(1);
    ctrl.abort();
    // The waiter unwinds at once — it does not wait for the submit.
    await expect(pending).rejects.toThrow("Cloud render aborted");
    expect(charges).toEqual([]);

    // The submit completes; the server debited 2cr on it.
    release();
    await Bun.sleep(20);

    expect(charges).toEqual([
      { units: 1, credits: 2, breakdown: [{ feature: "render", units: 1, credits: 2 }] },
    ]);
    expect(budget.spent).toBe(2);
    // No fallback for an aborted caller (unchanged).
    expect(fallback.requests).toHaveLength(0);
  });
});

// ── End to end through the real crawler ─────────────────────────────────────

const CRAWL_CONFIG: Partial<CrawlerConfig> = {
  maxPages: 3,
  concurrency: 2,
  perHostConcurrency: 2,
  delayMs: 0,
  perHostDelayMs: 0,
  timeoutMs: OUTER_MS,
  userAgent: "squirrel-test",
  respectRobots: false,
  incremental: false,
  useCacheControl: false,
  breadthFirst: false,
  coverageMode: "quick",
};

describe("through the crawler: a wedged render never costs the page (#2026)", () => {
  test("every page lands via the fallback inside the per-page deadline; no abort, no entry retry", async () => {
    const origin = serveOrigin(20);
    const documentFetcher = createCloudDocumentFetcher(neverReturningClient(), {
      ...fastPolling,
      fallback: createFetchDocumentFetcher(),
      timeoutMs: 10_000,
    });
    const crawler = await Effect.runPromise(
      createCrawler({ config: { ...CRAWL_CONFIG, documentFetcher } }),
    );
    const warnings: string[] = [];
    const failed: string[] = [];
    const events = Effect.runFork(
      Stream.runForEach(crawler.events, (event: CrawlerEvent) =>
        Effect.sync(() => {
          if (event.type === "warning") warnings.push(event.code);
          if (event.type === "page:failed") failed.push(event.error);
        }),
      ),
    );
    try {
      const startedAt = Date.now();
      const crawlId = await Effect.runPromise(crawler.start(origin.url, origin.url));
      const pages = await Effect.runPromise(crawler.storage.getPages(crawlId));
      const stats = await Effect.runPromise(crawler.storage.getStats(crawlId));

      expect(pages.map((p) => p.url)).toContain(origin.url);
      expect(pages.length).toBe(3);
      expect(failed).toEqual([]);
      expect(stats?.rootFailure).toBeUndefined();
      // The #1699 second chance never had to fire: the first attempt landed.
      expect(warnings).not.toContain("entry-fetch-retried");
      // Three pages, two at a time, each ~headroom deep: well inside what a
      // wedged render used to cost (the batch budget per page).
      expect(Date.now() - startedAt).toBeLessThan(OUTER_MS * 3);
    } finally {
      await Effect.runPromise(Fiber.interrupt(events));
    }
  }, 15_000);
});

describe("codex review follow-ups (#2026)", () => {
  test("the headroom timer counts from acceptance: a coalescing window longer than the render's share cannot eat the fallback's slice", async () => {
    const origin = serveOrigin(20);
    const fetcher = createCloudDocumentFetcher(neverReturningClient(), {
      ...fastPolling,
      // Buffer for longer than outer - headroom; the race must still start on time.
      batchWindowMs: OUTER_MS - HEADROOM_MS + 100,
      fallback: createFetchDocumentFetcher(),
      timeoutMs: 10_000,
    });
    const startedAt = Date.now();
    const resp = await fetcher.fetch({
      url: origin.url,
      timeoutMs: OUTER_MS,
      signal: AbortSignal.timeout(OUTER_MS),
    });
    expect(resp.fetcherMethod).toBe("fetch");
    expect(Date.now() - startedAt).toBeLessThan(OUTER_MS);
  });

  test("the poll loop stops as soon as the last racing waiter settles, instead of polling on to the deadline", async () => {
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1", status: "queued" as const, charged: 2 }),
      renderResult: async (jobId: string) => {
        polls++;
        return { jobId, status: "running" as const };
      },
    } as unknown as CloudServicesClient;
    const fallback = fallbackFetcher({ delayMs: 30 });
    const fetcher = createCloudDocumentFetcher(client, {
      ...fastPolling,
      pollIntervalMs: 200,
      fallback: fallback.fetcher,
      timeoutMs: 5_000,
    });
    const resp = await fetcher.fetch({ url: URL_A, timeoutMs: OUTER_MS });
    expect(resp.body).toBe("fallback");
    const after = polls;
    await Bun.sleep(300);
    // At most one poll already in flight can still land after settlement.
    expect(polls).toBeLessThanOrEqual(after + 1);
  });
});
