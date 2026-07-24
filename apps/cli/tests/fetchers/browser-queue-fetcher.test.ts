import { createBrowserQueueDocumentFetcher } from "@squirrelscan/fetchers";
import { afterEach, describe, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createBrowserQueueDocumentFetcher", () => {
  test("includes accounting context in queued render jobs", async () => {
    const createBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input.toString();
      if (url.endsWith("/internal/render-jobs")) {
        createBodies.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        );
        return new Response(JSON.stringify({ jobId: "job_ctx" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          result: {
            sourceUrl: "https://example.com",
            finalUrl: "https://example.com",
            status: 200,
            headers: {},
            body: "<html></html>",
            startedAt: 1000,
            responseAt: 1010,
            finishedAt: 1100,
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 100,
      runId: "run_123",
      userId: "user_123",
      crawlId: "crawl_123",
      apiBaseUrl: "http://host.docker.internal:4001",
    });

    await fetcher.fetch({ url: "https://example.com" });
    const createBody = createBodies[0];
    if (!createBody) {
      throw new Error("missing create body");
    }
    expect(createBody["runId"]).toBe("run_123");
    expect(createBody["userId"]).toBe("user_123");
    expect(createBody["crawlId"]).toBe("crawl_123");
    expect(createBody["apiBaseUrl"]).toBe("http://host.docker.internal:4001");
  });

  test("returns rendered response after queue completion", async () => {
    const responses = [
      new Response(JSON.stringify({ jobId: "job_1" }), { status: 200 }),
      new Response(JSON.stringify({ status: "running" }), { status: 200 }),
      new Response(
        JSON.stringify({
          status: "completed",
          result: {
            sourceUrl: "https://example.com",
            finalUrl: "https://example.com/home",
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<html><body>Hello</body></html>",
            startedAt: 1000,
            responseAt: 1100,
            finishedAt: 1300,
          },
        }),
        { status: 200 }
      ),
    ];

    globalThis.fetch = (async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected fetch call");
      }
      return next;
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const response = await fetcher.fetch({ url: "https://example.com" });
    expect(response.status).toBe(200);
    expect(response.finalUrl).toBe("https://example.com/home");
    expect(response.body).toContain("Hello");
  });

  test("throws when queue reports failure", async () => {
    const responses = [
      new Response(JSON.stringify({ jobId: "job_2" }), { status: 200 }),
      new Response(
        JSON.stringify({ status: "failed", error: "browser timeout" }),
        {
          status: 200,
        }
      ),
    ];
    globalThis.fetch = (async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected fetch call");
      }
      return next;
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    await expect(fetcher.fetch({ url: "https://example.com" })).rejects.toThrow(
      "browser timeout"
    );
  });

  test("times out cleanly when a status poll request hangs", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = input.toString();
      if (url.endsWith("/internal/render-jobs")) {
        return new Response(JSON.stringify({ jobId: "job_hang" }), {
          status: 200,
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 30,
    });

    await expect(fetcher.fetch({ url: "https://example.com" })).rejects.toThrow(
      "timed out"
    );
  });

  test("times out cleanly when status request ignores abort", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/internal/render-jobs")) {
        return new Response(JSON.stringify({ jobId: "job_no_abort" }), {
          status: 200,
        });
      }
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 35,
    });

    await expect(fetcher.fetch({ url: "https://example.com" })).rejects.toThrow(
      "timed out"
    );
  });

  test("times out cleanly when status body parsing hangs", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/internal/render-jobs")) {
        return new Response(JSON.stringify({ jobId: "job_json_hang" }), {
          status: 200,
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => await new Promise<never>(() => {}),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 35,
    });

    await expect(fetcher.fetch({ url: "https://example.com" })).rejects.toThrow(
      "timed out"
    );
  });

  test("times out when queue never completes", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith("/internal/render-jobs")) {
        return new Response(JSON.stringify({ jobId: "job_3" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: "running" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const fetcher = createBrowserQueueDocumentFetcher({
      serviceUrl: "http://crawler.local",
      pollIntervalMs: 1,
      timeoutMs: 15,
    });

    await expect(fetcher.fetch({ url: "https://example.com" })).rejects.toThrow(
      "timed out"
    );
  });
});
