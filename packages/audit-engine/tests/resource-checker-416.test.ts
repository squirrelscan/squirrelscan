// Regression test: GET fallback must not record a Range-rejection 416 as the
// resource's status — it retries once WITHOUT Range to capture the real status,
// preventing live URLs from being flagged 4xx in crawl/sitemap-4xx (#235).

import { Effect } from "effect";
import { afterEach, describe, expect, test } from "bun:test";

import { checkResourceSizes } from "../src/resource-checker";
import { createFetchBudget } from "../src/fetch-budget";

type FetchCall = { url: string; method: string; range: string | null };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch stub; returns the recorded calls for assertions. */
function stubFetch(
  handler: (call: FetchCall) => Response
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      range: headers.get("range"),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls };
}

describe("resource-checker GET fallback 416 handling (#235)", () => {
  test("retries without Range and records the real status when the server rejects Range with 416", async () => {
    const url = "https://www.cloudflare.com/case-studies/";
    const { calls } = stubFetch((call) => {
      // HEAD fails → forces the GET fallback.
      if (call.method === "HEAD") {
        throw new Error("HEAD not supported");
      }
      // Ranged GET → server rejects Range with 416.
      if (call.range === "bytes=0-0") {
        return new Response(null, { status: 416 });
      }
      // Retried GET without Range → real status.
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "2" },
      });
    });

    const [result] = await Effect.runPromise(
      checkResourceSizes([url], { priorByUrl: undefined })
    );

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    // HEAD, ranged GET (416), then a plain GET retry without Range.
    const getCalls = calls.filter((c) => c.method === "GET");
    expect(getCalls).toHaveLength(2);
    expect(getCalls[0].range).toBe("bytes=0-0");
    expect(getCalls[1].range).toBeNull();
  });

  test("does not retry when the ranged GET succeeds (keeps the Range optimization)", async () => {
    const url = "https://www.cloudflare.com/learning/";
    const { calls } = stubFetch((call) => {
      if (call.method === "HEAD") {
        throw new Error("HEAD not supported");
      }
      // Server honors Range → 206 with Content-Range giving the full size.
      return new Response("x", {
        status: 206,
        headers: {
          "content-type": "text/html",
          "content-length": "1",
          "content-range": "bytes 0-0/12345",
        },
      });
    });

    const [result] = await Effect.runPromise(checkResourceSizes([url]));

    expect(result.status).toBe(206);
    expect(result.sizeBytes).toBe(12345);
    const getCalls = calls.filter((c) => c.method === "GET");
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].range).toBe("bytes=0-0");
  });

  test("records a genuine 404 from the GET fallback (no spurious retry)", async () => {
    const url = "https://www.cloudflare.com/does-not-exist/";
    const { calls } = stubFetch((call) => {
      if (call.method === "HEAD") {
        throw new Error("HEAD not supported");
      }
      return new Response("nope", {
        status: 404,
        headers: { "content-type": "text/html", "content-length": "4" },
      });
    });

    const [result] = await Effect.runPromise(checkResourceSizes([url]));

    expect(result.status).toBe(404);
    const getCalls = calls.filter((c) => c.method === "GET");
    expect(getCalls).toHaveLength(1);
  });
});

// #1252: a shared fetch budget threaded through checkResourceSizes must skip
// remaining URLs (no fetch) once its deadline has passed, returning a bounded
// "skipped" placeholder instead of hammering a slow host.
describe("resource-checker fetch budget (#1252)", () => {
  test("skips URLs whose fetch would start after the budget deadline", async () => {
    const { calls } = stubFetch(() =>
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/css", "content-length": "2" },
      }),
    );

    // Advance the injected clock past the deadline before the checks run → every
    // URL is skipped before its fetch starts.
    let clock = 0;
    const budget = createFetchBudget({ totalBudgetMs: 1, now: () => clock });
    clock = 1000; // now well past deadline (startedAt 0 + 1ms budget)
    const urls = ["https://a.com/1.css", "https://a.com/2.css", "https://a.com/3.css"];
    const results = await Effect.runPromise(
      checkResourceSizes(urls, { budget, concurrency: 1 }),
    );

    // No network calls — all three were skipped before fetch.
    expect(calls).toHaveLength(0);
    expect(results.map((r) => r.error)).toEqual(["skipped", "skipped", "skipped"]);
    expect(budget.summary().degraded).toBe(true);
    expect(budget.summary().reason).toBe("budget");
  });

  test("fetches normally when the budget has headroom", async () => {
    const { calls } = stubFetch(() =>
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/css", "content-length": "2" },
      }),
    );
    const budget = createFetchBudget({ totalBudgetMs: 60_000 });
    const results = await Effect.runPromise(
      checkResourceSizes(["https://a.com/1.css"], { budget }),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(results[0].status).toBe(200);
    expect(budget.summary().degraded).toBe(false);
    expect(budget.summary().attempted).toBe(1);
  });
});
