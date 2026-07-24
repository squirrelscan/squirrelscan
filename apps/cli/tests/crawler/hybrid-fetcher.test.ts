// HTTP-first hybrid fetcher (#294): HTTP every page, render only CSR shells.

import type {
  DocumentFetcher,
  FetchRequest,
  FetchResponse,
} from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";

import { createHybridDocumentFetcher } from "../../src/crawl/hybrid-fetcher";

function resp(body: string, over: Partial<FetchResponse> = {}): FetchResponse {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    headers: { "content-type": "text/html" },
    body,
    timing: { startedAt: 0, responseAt: 1, finishedAt: 1 },
    redirectChain: {
      sourceUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      hops: [],
      chainLength: 0,
      isLoop: false,
      endsInError: false,
      httpsToHttp: false,
      httpToHttps: false,
    },
    ...over,
  };
}

function stub(
  id: string,
  calls: string[],
  impl: (req: FetchRequest) => Promise<FetchResponse>
): DocumentFetcher {
  return {
    id,
    capabilities: {
      jsRendering: id === "render",
      cookies: false,
      screenshot: false,
    },
    fetch: (req) => {
      calls.push(req.url);
      return impl(req);
    },
  };
}

const SSR =
  "<body><main><h1>Real content</h1><p>" +
  "x ".repeat(200) +
  "</p></main></body>";
const SHELL = `<body><div id="root"></div><script src="/b.js"></script></body>`;

describe("createHybridDocumentFetcher", () => {
  test("server-rendered page: HTTP only, no render", async () => {
    const httpCalls: string[] = [];
    const renderCalls: string[] = [];
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", httpCalls, async () => resp(SSR)),
      render: stub("render", renderCalls, async () => resp("<rendered/>")),
    });

    const r = await fetcher.fetch({ url: "https://example.com/" });
    expect(r.body).toBe(SSR);
    expect(httpCalls).toEqual(["https://example.com/"]);
    expect(renderCalls).toEqual([]); // never rendered → zero render credits
  });

  test("CSR shell: upgraded to render", async () => {
    const httpCalls: string[] = [];
    const renderCalls: string[] = [];
    const upgrades: string[] = [];
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", httpCalls, async () => resp(SHELL)),
      render: stub("render", renderCalls, async () =>
        resp("<html>rendered</html>")
      ),
      onUpgrade: (u) => upgrades.push(u),
    });

    const r = await fetcher.fetch({ url: "https://example.com/app" });
    expect(r.body).toBe("<html>rendered</html>");
    expect(httpCalls).toEqual(["https://example.com/app"]);
    expect(renderCalls).toEqual(["https://example.com/app"]);
    expect(upgrades).toEqual(["https://example.com/app"]);
  });

  test("render failure falls back to the HTTP response", async () => {
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", [], async () => resp(SHELL)),
      render: stub("render", [], async () => {
        throw new Error("render exploded");
      }),
    });

    const r = await fetcher.fetch({ url: "https://example.com/app" });
    expect(r.body).toBe(SHELL); // page not lost
  });

  test("render error while aborted propagates (does not mask the interruption)", async () => {
    const controller = new AbortController();
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", [], async () => resp(SHELL)),
      render: stub("render", [], async () => {
        controller.abort(); // crawl interrupted mid-upgrade
        throw new Error("aborted");
      }),
    });

    await expect(
      fetcher.fetch({
        url: "https://example.com/app",
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });

  test("does not upgrade non-HTML responses", async () => {
    const renderCalls: string[] = [];
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", [], async () =>
        resp("{}", { headers: { "content-type": "application/json" } })
      ),
      render: stub("render", renderCalls, async () => resp("nope")),
    });

    await fetcher.fetch({ url: "https://example.com/api" });
    expect(renderCalls).toEqual([]);
  });

  test("does not upgrade when the signal is already aborted", async () => {
    const renderCalls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const fetcher = createHybridDocumentFetcher({
      http: stub("http", [], async () => resp(SHELL)),
      render: stub("render", renderCalls, async () => resp("rendered")),
    });

    const r = await fetcher.fetch({
      url: "https://example.com/app",
      signal: controller.signal,
    });
    expect(r.body).toBe(SHELL);
    expect(renderCalls).toEqual([]);
  });
});
