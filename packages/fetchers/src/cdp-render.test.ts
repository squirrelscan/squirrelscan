// #2306: the CDP render fetcher against a fake DevTools Protocol browser (a real WebSocket server on
// 127.0.0.1), so the wire handling, the redirect chain and every fallback path are exercised.

import { afterEach, describe, expect, it } from "bun:test";

import type { DocumentFetcher, FetchRequest, FetchResponse } from "./index";

import {
  CDP_REASON_PREFIX,
  CDP_RENDER_FETCHER_ID,
  createCdpRenderFetcher,
  resolveCdpWebSocketUrl,
} from "./cdp-render";

interface FakePage {
  /** The status the main document answers with. */
  status?: number;
  mime?: string;
  html?: string;
  /** Redirect hops (url, status) the document went through before landing. */
  redirects?: Array<{ url: string; status: number }>;
  /** Never deliver the load event: the render must time out. */
  hang?: boolean;
  /** A redirect hop the browser pauses on, for the egress policy to vet. */
  pausedHop?: string;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let opened: string[] = [];
let closedTargets = 0;
let userAgents: string[] = [];
let fetchDecisions: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** A browser-level CDP endpoint; `pages(url)` scripts what each navigation does. */
function startBrowser(pages: (url: string) => FakePage): {
  wsUrl: string;
  httpUrl: string;
} {
  server?.stop(true);
  opened = [];
  closedTargets = 0;
  userAgents = [];
  fetchDecisions = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") {
        return Response.json({
          webSocketDebuggerUrl: `ws://browser-internal:1/devtools/browser/abc`,
        });
      }
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw): void {
        void handle(ws, raw);
      },
    },
  });
  function handle(
    ws: { send(data: string): unknown },
    raw: string | Buffer
  ): unknown {
    {
      const msg = JSON.parse(String(raw)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      const reply = (result: Record<string, unknown>) =>
        ws.send(
          JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId })
        );
      const event = (method: string, params: Record<string, unknown>) =>
        ws.send(JSON.stringify({ method, params, sessionId: msg.sessionId }));
      switch (msg.method) {
        case "Target.createTarget":
          return reply({ targetId: "T1" });
        case "Target.attachToTarget":
          return reply({ sessionId: "S1" });
        case "Target.closeTarget":
          closedTargets++;
          return reply({ success: true });
        case "Fetch.failRequest":
        case "Fetch.continueRequest":
          fetchDecisions.push(`${msg.method}:${String(msg.params.requestId)}`);
          return reply({});
        case "Network.setUserAgentOverride":
          userAgents.push(String(msg.params.userAgent));
          return reply({});
        case "Page.navigate": {
          const target = String(msg.params.url);
          opened.push(target);
          reply({ frameId: "T1" });
          const page = pages(target);
          const hops = [...(page.redirects ?? [])];
          if (page.pausedHop)
            event("Fetch.requestPaused", {
              requestId: "F1",
              redirectedRequestId: "R0",
              request: { url: page.pausedHop },
            });
          let at = hops[0]?.url ?? target;
          event("Network.requestWillBeSent", {
            requestId: "R1",
            type: "Document",
            frameId: "T1",
            request: { url: at },
          });
          for (const [i, hop] of hops.entries()) {
            at = hops[i + 1]?.url ?? target;
            event("Network.requestWillBeSent", {
              requestId: "R1",
              type: "Document",
              frameId: "T1",
              request: { url: at },
              redirectResponse: { url: hop.url, status: hop.status },
            });
          }
          // A subresource that finishes, and a redirected request's id must not wedge the settle wait.
          event("Network.requestWillBeSent", {
            requestId: "R2",
            type: "Script",
            frameId: "T1",
            request: { url: `${target}/app.js` },
          });
          event("Network.responseReceived", {
            requestId: "R1",
            type: "Document",
            response: {
              url: target,
              status: page.status ?? 200,
              mimeType: page.mime ?? "text/html",
              headers: {
                "Content-Type": "text/html",
                "Set-Cookie": "a=1\nb=2",
              },
            },
          });
          event("Network.loadingFinished", { requestId: "R1" });
          event("Network.loadingFinished", { requestId: "R2" });
          if (!page.hang) event("Page.loadEventFired", {});
          return undefined;
        }
        case "Runtime.evaluate": {
          const url = opened.at(-1) ?? "";
          const html = pages(url).html ?? "<html><body>rendered</body></html>";
          return reply({
            result: {
              value: JSON.stringify({
                href: url,
                html: `<!DOCTYPE html>${html}`,
              }),
            },
          });
        }
        default:
          return reply({});
      }
    }
  }
  const port = server.port;
  return {
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser/abc`,
    httpUrl: `http://127.0.0.1:${port}`,
  };
}

function fakeHttp(): DocumentFetcher & { calls: FetchRequest[] } {
  const calls: FetchRequest[] = [];
  return {
    id: "fetch",
    capabilities: { jsRendering: false, cookies: true, screenshot: false },
    calls,
    async fetch(req): Promise<FetchResponse> {
      calls.push(req);
      return {
        url: req.url,
        finalUrl: req.url,
        status: 200,
        headers: {},
        body: "<html>plain</html>",
        timing: { startedAt: 0, responseAt: 0, finishedAt: 0 },
        redirectChain: {
          sourceUrl: req.url,
          finalUrl: req.url,
          hops: [{ url: req.url, statusCode: 200, type: "http" }],
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
}

const fast = { settleMs: 10, connectTimeoutMs: 1_000 };

describe("cdp-render fetcher (#2306)", () => {
  it("returns the rendered DOM with the main document's status, headers and redirect chain", async () => {
    const { wsUrl } = startBrowser(() => ({
      redirects: [{ url: "https://example.com/old", status: 301 }],
      html: "<html><body><h1>Built by JS</h1></body></html>",
    }));
    const http = fakeHttp();
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: http,
      ...fast,
    });

    const res = await fetcher.fetch({
      url: "https://example.com/new",
      headers: { "User-Agent": "squirrel-test" },
    });

    expect(fetcher.id).toBe(CDP_RENDER_FETCHER_ID);
    expect(res.fetcherMethod).toBe(CDP_RENDER_FETCHER_ID);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<h1>Built by JS</h1>");
    expect(res.headers["content-type"]).toBe("text/html");
    expect(res.headers["set-cookie"]).toBe("a=1\nb=2");
    expect(res.redirectChain.hops).toEqual([
      { url: "https://example.com/old", statusCode: 301, type: "http" },
      { url: "https://example.com/new", statusCode: 200, type: "http" },
    ]);
    expect(res.redirectChain.chainLength).toBe(1);
    expect(userAgents).toEqual(["squirrel-test"]);
    expect(http.calls).toHaveLength(0);
    expect(closedTargets).toBe(1);
    await fetcher.close();
  });

  it("resolves an http:// endpoint through /json/version and keeps the host the user gave", async () => {
    const { httpUrl } = startBrowser(() => ({}));
    const ws = await resolveCdpWebSocketUrl(httpUrl);
    const port = new URL(httpUrl).port;
    expect(ws).toBe(`ws://127.0.0.1:${port}/devtools/browser/abc`);

    const fetcher = createCdpRenderFetcher({
      endpoint: httpUrl,
      fallback: fakeHttp(),
      ...fast,
    });
    const res = await fetcher.fetch({ url: "https://example.com/" });
    expect(res.fetcherMethod).toBe(CDP_RENDER_FETCHER_ID);
    await fetcher.close();
  });

  it("goes to plain HTTP for the whole run, once and with the reason, when the endpoint is unreachable", async () => {
    const reasons: string[] = [];
    const http = fakeHttp();
    const fetcher = createCdpRenderFetcher({
      endpoint: "ws://127.0.0.1:1/devtools/browser/none",
      fallback: http,
      onFallback: (r) => reasons.push(r),
      ...fast,
    });

    const a = await fetcher.fetch({ url: "https://example.com/a" });
    const b = await fetcher.fetch({ url: "https://example.com/b" });

    expect(a.fetcherMethod).toBe("fetch");
    expect(a.fallbackReason).toBe("render-unavailable");
    expect(b.body).toBe("<html>plain</html>");
    expect(http.calls.map((c) => c.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toStartWith(`${CDP_REASON_PREFIX} endpoint unreachable`);
  });

  it("serves one page over plain HTTP when the site blocks the browser, and keeps rendering the rest", async () => {
    const { wsUrl } = startBrowser((url) =>
      url.endsWith("/walled") ? { status: 403 } : {}
    );
    const http = fakeHttp();
    const pageFallbacks: string[] = [];
    const reasons: string[] = [];
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: http,
      onFallback: (r) => reasons.push(r),
      onPageFallback: (url) => pageFallbacks.push(url),
      ...fast,
    });

    const walled = await fetcher.fetch({ url: "https://example.com/walled" });
    const ok = await fetcher.fetch({ url: "https://example.com/ok" });

    expect(walled.fetcherMethod).toBe("fetch");
    expect(walled.fallbackReason).toBe("render-block");
    expect(ok.fetcherMethod).toBe(CDP_RENDER_FETCHER_ID);
    expect(pageFallbacks).toEqual(["https://example.com/walled"]);
    expect(reasons).toEqual([]);
    expect(closedTargets).toBe(2);
    await fetcher.close();
  });

  it("serves a non-HTML document over plain HTTP", async () => {
    const { wsUrl } = startBrowser(() => ({ mime: "application/pdf" }));
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: fakeHttp(),
      ...fast,
    });
    const res = await fetcher.fetch({ url: "https://example.com/file.pdf" });
    expect(res.fetcherMethod).toBe("fetch");
    expect(res.fallbackReason).toBe("render-failed");
    await fetcher.close();
  });

  it("falls back for a page whose render times out", async () => {
    const { wsUrl } = startBrowser(() => ({ hang: true }));
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: fakeHttp(),
      ...fast,
    });
    const res = await fetcher.fetch({
      url: "https://example.com/slow",
      timeoutMs: 300,
    });
    expect(res.fetcherMethod).toBe("fetch");
    expect(res.fallbackReason).toBe("render-failed");
    expect(closedTargets).toBe(1);
    await fetcher.close();
  });

  it("never opens the browser for a request it cannot do there (HEAD, followRedirects off)", async () => {
    const { wsUrl } = startBrowser(() => ({}));
    const http = fakeHttp();
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: http,
      ...fast,
    });
    await fetcher.fetch({ url: "https://example.com/h", method: "HEAD" });
    await fetcher.fetch({
      url: "https://example.com/n",
      followRedirects: false,
    });
    expect(opened).toEqual([]);
    expect(http.calls).toHaveLength(2);
    await fetcher.close();
  });

  it("rejects, with no plain fetch, when the caller aborts", async () => {
    const { wsUrl } = startBrowser(() => ({ hang: true }));
    const http = fakeHttp();
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: http,
      ...fast,
    });
    const controller = new AbortController();
    const pending = fetcher.fetch({
      url: "https://example.com/x",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow();
    expect(http.calls).toHaveLength(0);
    await fetcher.close();
  });

  it("fails a redirect hop to a metadata address the egress policy refuses, and lets a site hop through", async () => {
    const { wsUrl } = startBrowser(() => ({
      pausedHop: "http://169.254.169.254/latest",
    }));
    const fetcher = createCdpRenderFetcher({
      endpoint: wsUrl,
      fallback: fakeHttp(),
      ...fast,
    });
    await fetcher.fetch({
      url: "https://example.com/r",
      egress: {
        allowPrivateNetwork: false,
        resolve: async () => ["169.254.169.254"],
      },
    });
    await Bun.sleep(50);
    expect(fetchDecisions).toEqual(["Fetch.failRequest:F1"]);
    await fetcher.close();

    const { wsUrl: ws2 } = startBrowser(() => ({
      pausedHop: "https://example.com/next",
    }));
    const f2 = createCdpRenderFetcher({
      endpoint: ws2,
      fallback: fakeHttp(),
      ...fast,
    });
    await f2.fetch({
      url: "https://example.com/r",
      egress: {
        allowPrivateNetwork: false,
        resolve: async () => ["93.184.216.34"],
      },
    });
    await Bun.sleep(50);
    expect(fetchDecisions).toEqual(["Fetch.continueRequest:F1"]);
    await f2.close();
  });

  it("keeps endpoint credentials out of every fallback reason", async () => {
    server?.stop(true);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    const secret = "hunter2-cdp-secret";
    const endpoint = `http://admin:${secret}@127.0.0.1:${server.port}`;
    const err = await resolveCdpWebSocketUrl(endpoint).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("answered 500");
    expect((err as Error).message).not.toContain(secret);
    expect((err as Error).message).not.toContain("admin");

    const reasons: string[] = [];
    const fetcher = createCdpRenderFetcher({
      endpoint,
      fallback: fakeHttp(),
      onFallback: (r) => reasons.push(r),
      ...fast,
    });
    await fetcher.fetch({ url: "https://example.com/" });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("answered 500");
    expect(reasons[0]).not.toContain(secret);

    const bad = await resolveCdpWebSocketUrl(
      `http://admin:${secret}@[bad`
    ).catch((e: Error) => e);
    expect((bad as Error).message).not.toContain(secret);
    await fetcher.close();
  });

  it("refuses endpoints that are not ws or http", async () => {
    await expect(
      resolveCdpWebSocketUrl("file:///etc/passwd")
    ).rejects.toThrow();
    await expect(resolveCdpWebSocketUrl("not a url")).rejects.toThrow();
  });
});
