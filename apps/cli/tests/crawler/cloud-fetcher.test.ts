// Render spend accounting + fallback behavior of the cloud-render
// DocumentFetcher. Render is charged ON SUBMIT (per url), so the
// onRenderCharged counter must fire exactly once per successful submit —
// including jobs that later fail — and never when the submit itself fails.

import type {
  DocumentFetcher,
  FetchRequest,
  FetchResponse,
} from "@squirrelscan/fetchers";

import {
  createCloudDocumentFetcher,
  isRenderBlocked,
} from "@squirrelscan/audit-engine";
import { CloudClientError } from "@squirrelscan/cloud-client";
import { describe, expect, test } from "bun:test";

const REQ: FetchRequest = { url: "https://example.com/page" };

function fallbackFetcher(): { fetcher: DocumentFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: DocumentFetcher = {
    id: "fallback",
    capabilities: { jsRendering: false, cookies: false, screenshot: false },
    async fetch(req): Promise<FetchResponse> {
      calls.push(req.url);
      return {
        url: req.url,
        finalUrl: req.url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: "fallback",
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
  return { fetcher, calls };
}

// Minimal client stub: only render/renderResult are exercised by the fetcher.
function renderClient(overrides: {
  render?: () => Promise<{
    jobId: string;
    charged?: number;
    chargedBreakdown?: Array<{
      feature: "render" | "render_cached";
      units: number;
      credits: number;
    }>;
  }>;
  renderResult?: (jobId: string) => Promise<{
    jobId: string;
    status: "queued" | "running" | "done" | "error";
    results?: Array<{
      url: string;
      status: number | null;
      html?: string;
      error?: string | null;
    }>;
    error?: string | null;
  }>;
}) {
  return {
    render: overrides.render ?? (async () => ({ jobId: "job-1" })),
    renderResult:
      overrides.renderResult ??
      (async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: REQ.url, status: 200, html: "<html>rendered</html>" }],
      })),
  } as never;
}

describe("cloud fetcher render spend counter", () => {
  test("successful render fires onRenderCharged once with 1 unit", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const charged: number[] = [];
    const fetcher = createCloudDocumentFetcher(renderClient({}), {
      fallback,
      pollIntervalMs: 1,
      timeoutMs: 500,
      onRenderCharged: (units) => charged.push(units),
    });

    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("<html>rendered</html>");
    expect(res.fetcherMethod).toBe("cloud-render");
    expect(charged).toEqual([1]);
  });

  test("reports the server's actual debit + breakdown — render_cached (1cr) on a cache hit #279", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const credits: number[] = [];
    const breakdowns: unknown[] = [];
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        render: async () => ({
          jobId: "job-1",
          charged: 1,
          chargedBreakdown: [
            { feature: "render_cached", units: 1, credits: 1 },
          ],
        }),
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderCharged: (_units, c, breakdown) => {
          credits.push(c);
          breakdowns.push(breakdown);
        },
      }
    );

    await fetcher.fetch(REQ);
    expect(credits).toEqual([1]);
    expect(breakdowns).toEqual([
      [{ feature: "render_cached", units: 1, credits: 1 }],
    ]);
  });

  test("falls back to the render miss cost (2cr) + synthesized breakdown when the server omits charged #279", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const credits: number[] = [];
    const breakdowns: unknown[] = [];
    const fetcher = createCloudDocumentFetcher(renderClient({}), {
      fallback,
      pollIntervalMs: 1,
      timeoutMs: 500,
      onRenderCharged: (_units, c, breakdown) => {
        credits.push(c);
        breakdowns.push(breakdown);
      },
    });

    await fetcher.fetch(REQ);
    expect(credits).toEqual([2]);
    // No server split → the whole batch is attributed to `render` (miss cost).
    expect(breakdowns).toEqual([[{ feature: "render", units: 1, credits: 2 }]]);
  });

  test("counts every successful submit across multiple pages", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let charged = 0;
    const fetcher = createCloudDocumentFetcher(renderClient({}), {
      fallback,
      pollIntervalMs: 1,
      timeoutMs: 500,
      onRenderCharged: (units) => {
        charged += units;
      },
    });

    await fetcher.fetch(REQ);
    await fetcher.fetch({ url: "https://example.com/two" });
    await fetcher.fetch({ url: "https://example.com/three" });
    expect(charged).toBe(3);
  });

  test("failed submit does NOT count and falls back for that url", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let charged = 0;
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        render: async () => {
          throw new CloudClientError("insufficient_credits", 402, "out");
        },
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderCharged: () => {
          charged += 1;
        },
      }
    );

    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("fallback");
    expect(charged).toBe(0);
    expect(calls).toEqual([REQ.url]);
  });

  test("job that errors AFTER a successful submit still counts (charge-on-submit)", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let charged = 0;
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        renderResult: async (jobId) => ({
          jobId,
          status: "error",
          error: "browser crashed",
        }),
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderCharged: (units) => {
          charged += units;
        },
      }
    );

    const res = await fetcher.fetch(REQ);
    // Per-url fallback served the page, but the submit was still charged.
    expect(res.body).toBe("fallback");
    expect(charged).toBe(1);
    expect(calls).toEqual([REQ.url]);
  });

  test("after permanent fallback, no further submits are charged", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let charged = 0;
    let submits = 0;
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        render: async () => {
          submits++;
          throw new CloudClientError("not_authenticated", 401, "expired");
        },
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderCharged: () => {
          charged += 1;
        },
      }
    );

    await fetcher.fetch(REQ);
    await fetcher.fetch({ url: "https://example.com/two" });
    expect(submits).toBe(1); // terminal condition flips to fallback permanently
    expect(charged).toBe(0);
  });
});

describe("cloud fetcher cancellation", () => {
  test("an aborted signal propagates and does NOT fall back", async () => {
    // When the crawl is interrupted (per-URL watchdog / stop), the render must
    // unwind so the fiber releases its host-scheduler slot — NOT start a
    // fallback fetch (which would just abort too and risk re-wedging).
    const { fetcher: fallback, calls } = fallbackFetcher();
    const controller = new AbortController();
    controller.abort();
    const fetcher = createCloudDocumentFetcher(renderClient({}), {
      fallback,
      pollIntervalMs: 1,
      timeoutMs: 500,
    });

    await expect(
      fetcher.fetch({ ...REQ, signal: controller.signal })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("forwards an abort-linked signal to the cloud calls; caller abort rejects without fallback", async () => {
    // A batch shares ONE poll loop, so the cloud calls get a combined signal
    // (not the raw caller signal). Aborting the caller must still abort that
    // forwarded signal and reject the waiter — never start a fallback fetch.
    const { fetcher: fallback, calls } = fallbackFetcher();
    const controller = new AbortController();
    let renderSignal: AbortSignal | undefined;
    let resultSignal: AbortSignal | undefined;
    const client = {
      render: async (_req: unknown, opts?: { signal?: AbortSignal }) => {
        renderSignal = opts?.signal;
        return { jobId: "job-1" };
      },
      renderResult: async (jobId: string, opts?: { signal?: AbortSignal }) => {
        resultSignal = opts?.signal;
        // Abort the caller during the first poll; the next loop iteration unwinds.
        controller.abort();
        return { jobId, status: "running" as const };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 5,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 0,
    });

    await expect(
      fetcher.fetch({ ...REQ, signal: controller.signal })
    ).rejects.toThrow();
    expect(renderSignal).toBeDefined();
    // The forwarded poll signal aborts in lockstep with the caller.
    expect(resultSignal?.aborted).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("cloud fetcher batching (#269)", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";
  const C = "https://example.com/c";

  test("coalesces concurrent fetches into one job and demuxes by url", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let submits = 0;
    let submittedUrls: string[] = [];
    const client = {
      render: async (req: { urls: string[] }) => {
        submits++;
        submittedUrls = req.urls;
        return { jobId: "job-1" };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        // Deliberately reordered vs submit order — demux must match by url.
        results: [
          { url: C, status: 200, html: "<html>C</html>" },
          { url: A, status: 200, html: "<html>A</html>" },
          { url: B, status: 200, html: "<html>B</html>" },
        ],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
    });

    const [ra, rb, rc] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
      fetcher.fetch({ url: C }),
    ]);
    expect(submits).toBe(1);
    expect([...submittedUrls].sort()).toEqual([A, B, C].sort());
    expect(ra.body).toBe("<html>A</html>");
    expect(rb.body).toBe("<html>B</html>");
    expect(rc.body).toBe("<html>C</html>");
  });

  test("charges once per batch: units = pages submitted, credits = server total", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const events: Array<[number, number]> = [];
    const client = {
      render: async () => ({ jobId: "job-1", charged: 4 }),
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [
          { url: A, status: 200, html: "A" },
          { url: B, status: 200, html: "B" },
        ],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      onRenderCharged: (units, credits) => events.push([units, credits]),
    });

    await Promise.all([fetcher.fetch({ url: A }), fetcher.fetch({ url: B })]);
    expect(events).toEqual([[2, 4]]);
  });

  test("partial batch failure: only the errored/missing urls fall back, the rest render", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let charged = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [
          { url: A, status: 200, html: "<html>A</html>" },
          { url: B, status: null, error: "browser crashed" },
          // C is omitted entirely → also falls back.
        ],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      onRenderCharged: (units) => {
        charged += units;
      },
    });

    const [ra, rb, rc] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
      fetcher.fetch({ url: C }),
    ]);
    expect(ra.body).toBe("<html>A</html>");
    expect(rb.body).toBe("fallback");
    expect(rc.body).toBe("fallback");
    expect([...calls].sort()).toEqual([B, C].sort());
    // Charge-on-submit covers every page in the batch, even the failed ones.
    expect(charged).toBe(3);
  });

  test("a mid-flight abort of one batched url rejects it but the rest still render", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    const ctrl = new AbortController();
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) {
          // Still running on the first poll — abort B now (its watchdog fires).
          ctrl.abort();
          return { jobId, status: "running" as const };
        }
        return {
          jobId,
          status: "done" as const,
          results: [
            { url: A, status: 200, html: "<html>A</html>" },
            { url: B, status: 200, html: "<html>B</html>" },
          ],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 1000,
      batchWindowMs: 5,
    });

    const pa = fetcher.fetch({ url: A });
    const pb = fetcher.fetch({ url: B, signal: ctrl.signal });
    await expect(pb).rejects.toThrow();
    expect((await pa).body).toBe("<html>A</html>");
    // The aborted url unwinds (reject) — it must NOT start a fallback fetch.
    expect(calls).toEqual([]);
  });

  test("polls quickly on the first attempt instead of waiting the full interval", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let firstPollAt = 0;
    const start = Date.now();
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        if (firstPollAt === 0) firstPollAt = Date.now() - start;
        return {
          jobId,
          status: "done" as const,
          results: [{ url: REQ.url, status: 200, html: "x" }],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1000,
      firstPollDelayMs: 5,
      timeoutMs: 2000,
      batchWindowMs: 0,
    });

    await fetcher.fetch(REQ);
    // First poll fires near firstPollDelayMs (5ms), far below the 1000ms cap.
    expect(firstPollAt).toBeLessThan(500);
  });

  test("a fully-aborted batch is not counted as a cloud failure (no false permanent fallback)", async () => {
    // A cancelled batch's abort-induced transport error must NOT increment the
    // consecutive-failure counter, else repeated cancellations would wrongly
    // trip the permanent HTTP fallback.
    const { fetcher: fallback } = fallbackFetcher();
    let abortRound: AbortController | null = null;
    const client = {
      render: async () => {
        if (abortRound) {
          // Mid-submit cancellation → throw the transport error an aborted
          // underlying fetch produces.
          abortRound.abort();
          throw new CloudClientError("network_error", 0, "aborted");
        }
        return { jobId: "job-1" };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: REQ.url, status: 200, html: "<html>ok</html>" }],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
    });

    for (let i = 0; i < 3; i++) {
      abortRound = new AbortController();
      await expect(
        fetcher.fetch({
          url: `https://example.com/x${i}`,
          signal: abortRound.signal,
        })
      ).rejects.toThrow();
    }
    // Cloud is still attempted on a healthy request — NOT permanently disabled.
    abortRound = null;
    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("<html>ok</html>");
  });

  test("a throwing onRenderCharged callback does not discard the rendered page", async () => {
    // The accounting callback is wrapped — a throw must not abort the poll loop
    // or drop a page the server already rendered and charged for.
    const { fetcher: fallback } = fallbackFetcher();
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: REQ.url, status: 200, html: "<html>ok</html>" }],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 0,
      onRenderCharged: () => {
        throw new Error("boom");
      },
    });

    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("<html>ok</html>");
  });

  test("maxBatchUrls=1 keeps each url a separate single-url job", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let submits = 0;
    let maxUrlsInAnyJob = 0;
    const client = {
      render: async (req: { urls: string[] }) => {
        submits++;
        maxUrlsInAnyJob = Math.max(maxUrlsInAnyJob, req.urls.length);
        return { jobId: `job-${submits}` };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: A, status: 200, html: "<html>A</html>" }],
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      maxBatchUrls: 1,
    });

    await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: A }),
    ]);
    expect(submits).toBe(3);
    expect(maxUrlsInAnyJob).toBe(1);
  });

  test("a backlog beyond maxBatchUrls drains into multiple batches", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const sizes: number[] = [];
    const slugs = ["a", "b", "c", "d", "e"];
    const client = {
      render: async (req: { urls: string[] }) => {
        sizes.push(req.urls.length);
        return { jobId: `job-${sizes.length}` };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: slugs.map((s) => ({
          url: `https://example.com/${s}`,
          status: 200,
          html: `<html>${s}</html>`,
        })),
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      maxBatchUrls: 2,
    });

    // 5 concurrent urls, cap 2 → batches of 2 + 2 + 1.
    const results = await Promise.all(
      slugs.map((s) => fetcher.fetch({ url: `https://example.com/${s}` }))
    );
    expect(sizes.every((n) => n <= 2)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(5);
    expect(results.map((r) => r.body).sort()).toEqual([
      "<html>a</html>",
      "<html>b</html>",
      "<html>c</html>",
      "<html>d</html>",
      "<html>e</html>",
    ]);
  });

  test("status:error does not reset the transport-failure breaker (only status:done does)", async () => {
    // Parity with the legacy single-url logic: a status:error response (transport
    // OK, render failed) must NOT clear the consecutive transport-failure streak,
    // else interleaved app errors would keep the circuit breaker from ever firing.
    const { fetcher: fallback } = fallbackFetcher();
    let renders = 0;
    let fellBack = false;
    const client = {
      render: async () => {
        renders++;
        // 3rd submit succeeds (→ status:error poll); the rest are transport faults.
        if (renders === 3) return { jobId: "job-1" };
        throw new CloudClientError("network_error", 0, "down");
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "error" as const,
        error: "render failed",
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 0,
      onFallback: () => {
        fellBack = true;
      },
    });

    // ne(1), ne(2), submit-ok→status:error(streak stays 2), ne(3) → permanent fallback.
    for (let i = 0; i < 4; i++) {
      await fetcher.fetch({ url: `https://example.com/p${i}` });
    }
    expect(fellBack).toBe(true);
    const rendersAtTrip = renders;
    await fetcher.fetch({ url: "https://example.com/p5" });
    // Permanently fallen back → no further submit attempted.
    expect(renders).toBe(rendersAtTrip);
  });
});

describe("render-block fallback (#490)", () => {
  test("isRenderBlocked: 401/403/429/503 statuses are blocks", () => {
    for (const status of [401, 403, 429, 503]) {
      expect(
        isRenderBlocked({ url: REQ.url, status, html: "<html>x</html>" })
      ).toBe(true);
    }
  });

  test("isRenderBlocked: a 503 with plain (non-challenge) HTML is still a block", () => {
    // Guards the early-return/WAF-set sync: a bare 503 has no challenge markers,
    // so detectWafChallengePage would short-circuit to not-detected.
    expect(
      isRenderBlocked({
        url: REQ.url,
        status: 503,
        html: "<html><body>503 Service Unavailable</body></html>",
      })
    ).toBe(true);
  });

  test("isRenderBlocked: a normal 200 page is not a block", () => {
    expect(
      isRenderBlocked({
        url: REQ.url,
        status: 200,
        html: "<html>real content</html>",
      })
    ).toBe(false);
  });

  test("isRenderBlocked: a 200 with Cloudflare JS-challenge HTML is a block", () => {
    // Exercises the detectWafChallengePage content path — status 200 is NOT in
    // WAF_CHALLENGE_STATUS_CODES, so this only blocks via interstitial detection.
    expect(
      isRenderBlocked({
        url: REQ.url,
        status: 200,
        html: "<html><body>Just a moment... __cf_chl_opt = {}; cf-browser-verification</body></html>",
      })
    ).toBe(true);
  });

  test("isRenderBlocked: a WAF/bot-challenge interstitial is a block", () => {
    expect(
      isRenderBlocked({
        url: REQ.url,
        status: 503,
        html: "<html><body>Checking your browser before accessing... cf-browser-verification</body></html>",
      })
    ).toBe(true);
  });

  test("a rendered 403 retries via the non-browser fallback (local egress)", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    const blocked: string[] = [];
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        renderResult: async (jobId) => ({
          jobId,
          status: "done" as const,
          results: [
            { url: REQ.url, status: 403, html: "<html>Forbidden</html>" },
          ],
        }),
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderBlock: (url) => blocked.push(url),
      }
    );

    const res = await fetcher.fetch(REQ);
    // Served by the plain-HTTP fallback, not the blocked render.
    expect(res.body).toBe("fallback");
    expect(res.fetcherMethod).toBe("fetch");
    // #512: the fallback response is tagged so the report can surface it.
    expect(res.fallbackReason).toBe("render-block");
    expect(calls).toEqual([REQ.url]);
    expect(blocked).toEqual([REQ.url]);
  });

  test("a bodyless rendered 403 (no HTML) still fires onRenderBlock and falls back", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    const blocked: string[] = [];
    const fetcher = createCloudDocumentFetcher(
      renderClient({
        // WAF closed the connection: 403 with no html body.
        renderResult: async (jobId) => ({
          jobId,
          status: "done" as const,
          results: [{ url: REQ.url, status: 403 }],
        }),
      }),
      {
        fallback,
        pollIntervalMs: 1,
        timeoutMs: 500,
        onRenderBlock: (url) => blocked.push(url),
      }
    );

    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("fallback");
    expect(calls).toEqual([REQ.url]);
    expect(blocked).toEqual([REQ.url]);
  });

  test("a normal rendered 200 is NOT routed to the fallback", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    const blocked: string[] = [];
    const fetcher = createCloudDocumentFetcher(renderClient({}), {
      fallback,
      pollIntervalMs: 1,
      timeoutMs: 500,
      onRenderBlock: (url) => blocked.push(url),
    });

    const res = await fetcher.fetch(REQ);
    expect(res.body).toBe("<html>rendered</html>");
    expect(res.fetcherMethod).toBe("cloud-render");
    // #512: a normal render is not a fallback → no reason tag.
    expect(res.fallbackReason).toBeUndefined();
    expect(calls).toEqual([]);
    expect(blocked).toEqual([]);
  });
});

describe("budget preflight (#609)", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";
  const C = "https://example.com/c";

  test("with 1 credit left, a multi-url batch never submits — no overspend past the cap", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let submits = 0;
    const client = {
      render: async () => {
        submits++;
        return { jobId: "job-1", charged: 6 };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [],
      }),
    } as never;
    // 1 credit remaining < the 2cr worst-case miss cost → nothing affords.
    const budget = { spent: 9, cap: 10 };
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      budget,
    });

    const [ra, rb, rc] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
      fetcher.fetch({ url: C }),
    ]);
    expect(submits).toBe(0);
    expect(budget.spent).toBe(9);
    expect([ra.body, rb.body, rc.body]).toEqual([
      "fallback",
      "fallback",
      "fallback",
    ]);
    expect([...calls].sort()).toEqual([A, B, C].sort());
  });

  test("a batch is trimmed to the affordable prefix before submit", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let submittedUrls: string[] = [];
    const client = {
      render: async (req: { urls: string[] }) => {
        submittedUrls = req.urls;
        return { jobId: "job-1", charged: req.urls.length * 2 };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: submittedUrls.map((url) => ({
          url,
          status: 200,
          html: `<html>${url}</html>`,
        })),
      }),
    } as never;
    // cap 4 at 2cr/url affords 2 of the 3 queued urls.
    const budget = { spent: 0, cap: 4 };
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      budget,
    });

    const [ra, rb, rc] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
      fetcher.fetch({ url: C }),
    ]);
    expect(submittedUrls).toEqual([A, B]);
    expect(budget.spent).toBe(4); // exactly the cap, never past it
    expect(ra.body).toBe(`<html>${A}</html>`);
    expect(rb.body).toBe(`<html>${B}</html>`);
    expect(rc.body).toBe("fallback");
    expect(calls).toEqual([C]);
  });

  test("the server's actual debit (not the worst-case estimate) lands in budget.spent", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const events: Array<[number, number]> = [];
    const client = {
      render: async () => ({ jobId: "job-1", charged: 2 }), // cache hits — cheaper than 2×2cr
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [
          { url: A, status: 200, html: "A" },
          { url: B, status: 200, html: "B" },
        ],
      }),
    } as never;
    const budget = { spent: 0, cap: 100 };
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      budget,
      onRenderCharged: (units, credits) => events.push([units, credits]),
    });

    await Promise.all([fetcher.fetch({ url: A }), fetcher.fetch({ url: B })]);
    expect(budget.spent).toBe(2);
    // Observability callback still fires with the same debit.
    expect(events).toEqual([[2, 2]]);
  });

  test("a failed submit releases the reservation and leaves the budget unspent", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let submits = 0;
    const client = {
      render: async () => {
        submits++;
        if (submits === 1) {
          throw new CloudClientError("service_unavailable", 503, "down");
        }
        return { jobId: "job-2", charged: 2 };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: [{ url: B, status: 200, html: "<html>B</html>" }],
      }),
    } as never;
    const budget = { spent: 0, cap: 2 };
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
      budget,
    });

    const ra = await fetcher.fetch({ url: A });
    expect(ra.body).toBe("fallback");
    expect(budget.spent).toBe(0); // nothing debited, reservation released
    expect(calls).toEqual([A]);

    // The freed reservation lets the next url afford a submit.
    const rb = await fetcher.fetch({ url: B });
    expect(rb.body).toBe("<html>B</html>");
    expect(budget.spent).toBe(2);
    expect(submits).toBe(2);
  });

  test("no budget option leaves batches unbounded (CLI path unchanged)", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let submittedUrls: string[] = [];
    const client = {
      render: async (req: { urls: string[] }) => {
        submittedUrls = req.urls;
        return { jobId: "job-1" };
      },
      renderResult: async (jobId: string) => ({
        jobId,
        status: "done" as const,
        results: submittedUrls.map((url) => ({
          url,
          status: 200,
          html: "<html>x</html>",
        })),
      }),
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 500,
      batchWindowMs: 5,
    });

    await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
      fetcher.fetch({ url: C }),
    ]);
    expect([...submittedUrls].sort()).toEqual([A, B, C].sort());
  });
});

describe("cloud fetcher per-item early delivery (#992)", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("a finished url is delivered mid-batch; the straggler settles on the terminal poll", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let releasePoll2!: () => void;
    const poll2Gate = new Promise<void>((r) => {
      releasePoll2 = r;
    });
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) {
          // Aggregate still running, but A already finished → deliver it now.
          return {
            jobId,
            status: "running" as const,
            completed: [{ url: A, status: 200, html: "<html>A</html>" }],
          };
        }
        await poll2Gate; // stall the terminal poll so B can't settle yet
        return {
          jobId,
          status: "done" as const,
          results: [
            { url: A, status: 200, html: "<html>A</html>" },
            { url: B, status: 200, html: "<html>B</html>" },
          ],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 1000,
      batchWindowMs: 5,
    });

    const pa = fetcher.fetch({ url: A });
    const pb = fetcher.fetch({ url: B });

    // A settles from the first, non-terminal poll — no waiting on the batch.
    expect((await pa).body).toBe("<html>A</html>");

    // B is still pending while the terminal poll is gated (barrier removed for A,
    // not for B).
    let bSettled = false;
    void pb.then(() => {
      bSettled = true;
    });
    await tick();
    expect(bSettled).toBe(false);

    releasePoll2();
    expect((await pb).body).toBe("<html>B</html>");
  });

  test("re-sent `completed` items across polls don't double-settle or double-fall-back", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls <= 2) {
          // Same failed item on two successive running polls (server re-sends).
          return {
            jobId,
            status: "running" as const,
            completed: [{ url: A, status: null, error: "boom" }],
          };
        }
        return {
          jobId,
          status: "done" as const,
          results: [
            { url: A, status: null, error: "boom" },
            { url: B, status: 200, html: "<html>B</html>" },
          ],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 1000,
      batchWindowMs: 5,
    });

    const [ra, rb] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
    ]);
    // A's per-url failure fell back exactly once despite being re-sent + echoed
    // in the terminal results.
    expect(ra.body).toBe("fallback");
    expect(calls.filter((u) => u === A)).toHaveLength(1);
    expect(rb.body).toBe("<html>B</html>");
  });

  test("old server (no `completed` field) keeps the batch barrier — both settle on done", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    let releaseDone!: () => void;
    const doneGate = new Promise<void>((r) => {
      releaseDone = r;
    });
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) return { jobId, status: "running" as const }; // no completed field
        await doneGate;
        return {
          jobId,
          status: "done" as const,
          results: [
            { url: A, status: 200, html: "<html>A</html>" },
            { url: B, status: 200, html: "<html>B</html>" },
          ],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 1000,
      batchWindowMs: 5,
    });

    const pa = fetcher.fetch({ url: A });
    const pb = fetcher.fetch({ url: B });
    let aSettled = false;
    void pa.then(() => {
      aSettled = true;
    });
    await tick();
    // Barrier intact: without `completed`, nothing settles until the terminal poll.
    expect(aSettled).toBe(false);

    releaseDone();
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.body).toBe("<html>A</html>");
    expect(rb.body).toBe("<html>B</html>");
  });

  test("per-url failure in `completed` falls back for that url only; peers keep rendering", async () => {
    const { fetcher: fallback, calls } = fallbackFetcher();
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) {
          return {
            jobId,
            status: "running" as const,
            completed: [{ url: A, status: null, error: "render crashed" }],
          };
        }
        return {
          jobId,
          status: "done" as const,
          results: [
            { url: A, status: null, error: "render crashed" },
            { url: B, status: 200, html: "<html>B</html>" },
          ],
        };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 1,
      firstPollDelayMs: 1,
      timeoutMs: 1000,
      batchWindowMs: 5,
    });

    const [ra, rb] = await Promise.all([
      fetcher.fetch({ url: A }),
      fetcher.fetch({ url: B }),
    ]);
    expect(ra.body).toBe("fallback");
    expect(rb.body).toBe("<html>B</html>");
    // Only the failed url fell back — B rendered normally.
    expect(calls).toEqual([A]);
  });

  test("an early-settled url doesn't leave the loop zombie-polling when the rest abort (R-001)", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const ctrl = new AbortController();
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) {
          // A finishes; B still rendering. Aggregate stays running.
          return {
            jobId,
            status: "running" as const,
            completed: [{ url: A, status: 200, html: "<html>A</html>" }],
          };
        }
        // Aggregate never turns terminal — only retirement (or the deadline) can
        // end the loop. A zombie loop keeps landing here.
        return { jobId, status: "running" as const };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 3,
      firstPollDelayMs: 1,
      timeoutMs: 5000,
      batchWindowMs: 5,
    });

    const pa = fetcher.fetch({ url: A });
    const pb = fetcher.fetch({ url: B, signal: ctrl.signal });
    // A settles from the first, non-terminal poll.
    expect((await pa).body).toBe("<html>A</html>");

    // The only other url aborts → the batch is fully retired → the loop must stop.
    ctrl.abort();
    await expect(pb).rejects.toThrow();

    const before = polls;
    await new Promise((r) => setTimeout(r, 80));
    // No zombie polling toward the 5s deadline after retirement (at most one
    // already-in-flight poll can still land).
    expect(polls).toBeLessThanOrEqual(before + 1);
  });

  test("early delivery retires the last live url after a peer already aborted (R-001)", async () => {
    const { fetcher: fallback } = fallbackFetcher();
    const ctrl = new AbortController();
    let polls = 0;
    const client = {
      render: async () => ({ jobId: "job-1" }),
      renderResult: async (jobId: string) => {
        polls++;
        if (polls === 1) {
          // B aborts while A is still pending — no `completed` yet, so the abort
          // handler sees A live and does NOT stop the loop.
          ctrl.abort();
          return { jobId, status: "running" as const };
        }
        if (polls === 2) {
          // A finishes now; B already aborted → every url is retired.
          return {
            jobId,
            status: "running" as const,
            completed: [{ url: A, status: 200, html: "<html>A</html>" }],
          };
        }
        return { jobId, status: "running" as const };
      },
    } as never;
    const fetcher = createCloudDocumentFetcher(client, {
      fallback,
      pollIntervalMs: 3,
      firstPollDelayMs: 1,
      timeoutMs: 5000,
      batchWindowMs: 5,
    });

    const pa = fetcher.fetch({ url: A });
    const pb = fetcher.fetch({ url: B, signal: ctrl.signal });
    await expect(pb).rejects.toThrow();
    expect((await pa).body).toBe("<html>A</html>");

    // The post-delivery retirement check (not the abort handler) stops the loop
    // right after poll 2 — otherwise it would zombie-poll to the deadline.
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBeLessThan(6);
  });
});
