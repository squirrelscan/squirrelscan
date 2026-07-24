import { afterEach, describe, expect, test } from "bun:test";

import { type ApiClientConfig, createApiClient } from "./index";

// The package calls the global `fetch`; each test swaps in a stub and restores
// it. `as unknown as typeof fetch` because a bespoke stub doesn't carry fetch's
// `preconnect` overload.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response): RequestInit[] {
  const calls: RequestInit[] = [];
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push(init);
    return Promise.resolve(handler(String(input), init));
  }) as unknown as typeof fetch;
  return calls;
}

const client = (over: Partial<ApiClientConfig> = {}) =>
  createApiClient({
    baseUrl: "https://api.test",
    getToken: () => "tok_123",
    userAgent: "squirrel/test",
    ...over,
  });

describe("createApiClient", () => {
  test("request() joins the base URL, sends auth + UA + JSON, parses the body", async () => {
    const calls = stubFetch((url) => {
      expect(url).toBe("https://api.test/v1/thing");
      return Response.json({ id: "x" }, { status: 201 });
    });

    const result = await client().request<{ id: string }>("/v1/thing", { body: { a: 1 } });

    expect(result).toEqual({ ok: true, status: 201, data: { id: "x" } });
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_123");
    expect(headers["User-Agent"]).toBe("squirrel/test");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("auth:'required' short-circuits to status 0 when no token resolves", async () => {
    const calls = stubFetch(() => Response.json({}));
    const result = await client({ getToken: () => null }).request("/v1/x", {
      method: "POST",
      auth: "required",
    });

    expect(result).toEqual({ ok: false, status: 0, data: null });
    expect(calls).toHaveLength(0); // never hit the network
  });

  test("auth:'none' omits the Authorization header even when a token exists", async () => {
    const calls = stubFetch(() => Response.json({}));
    await client().request("/v1/x", { method: "POST", auth: "none" });

    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test("request() reports a non-2xx via status without throwing", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    const result = await client().request("/v1/x");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  test("a transport error resolves to status 0 (never throws)", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;
    const result = await client().request("/v1/x");
    expect(result).toEqual({ ok: false, status: 0, data: null });
  });

  test("fetch() retries transport errors then succeeds", async () => {
    let attempts = 0;
    globalThis.fetch = (() => {
      attempts += 1;
      if (attempts < 2) return Promise.reject(new Error("net"));
      return Promise.resolve(new Response("ok"));
    }) as unknown as typeof fetch;

    const response = await client().fetch("/v1/x", {}, { retries: 2, timeoutMs: 50 });
    expect(response.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("send() never throws on a non-2xx and routes it to onDebug", async () => {
    stubFetch(() => new Response("bad", { status: 500 }));
    const debug: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    await client({ onDebug: (msg, meta) => debug.push({ msg, meta }) }).send("/v1/x", {
      method: "POST",
    });
    expect(debug).toHaveLength(1);
    expect(debug[0]!.meta).toMatchObject({ status: 500 });
  });

  test("baseUrl thunk is resolved per call (live env override)", async () => {
    let base = "https://a.test";
    const urls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;

    const c = createApiClient({ baseUrl: () => base });
    await c.request("/p");
    base = "https://b.test";
    await c.request("/p");

    // The thunk must be re-evaluated per call, so the second request hits the
    // new base — assert the actual URLs, not just the call count.
    expect(urls).toEqual(["https://a.test/p", "https://b.test/p"]);
  });
});
