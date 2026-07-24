import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  CrawlError,
  fetchPage,
  fetchPageWithRetry,
  isTlsError,
  type TlsEvent,
} from "../../src/crawler/fetcher";

const redirectChain = {
  sourceUrl: "https://example.com",
  finalUrl: "https://example.com",
  hops: [
    { url: "https://example.com", statusCode: 200, type: "http" as const },
  ],
  chainLength: 0,
  isLoop: false,
  endsInError: false,
  httpsToHttp: false,
  httpToHttps: false,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Document fetcher that always rejects with a TLS handshake error. */
function tlsFailingFetcher(): DocumentFetcher {
  return {
    id: "browser-queue",
    capabilities: { jsRendering: true, cookies: true, screenshot: false },
    async fetch(): Promise<FetchResponse> {
      throw new Error(
        "write EPROTO ... SSL routines:ssl3_get_record:wrong version number"
      );
    },
  };
}

/** Document fetcher that resolves with status 0 (never connected). */
function statusZeroFetcher(): DocumentFetcher {
  return {
    id: "browser-queue",
    capabilities: { jsRendering: true, cookies: true, screenshot: false },
    async fetch(req): Promise<FetchResponse> {
      return {
        url: req.url,
        finalUrl: req.url,
        status: 0,
        headers: {},
        body: "",
        timing: { startedAt: 0, responseAt: 0, finishedAt: 0 },
        redirectChain,
      };
    },
  };
}

/** Mock standard fetch returning a 200 HTML page (no redirect). */
function mockStandardFetch(status = 200, body = "<html>ok</html>"): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
}

describe("isTlsError", () => {
  test("detects status 0 as TLS/connection failure", () => {
    expect(isTlsError(undefined, 0)).toBe(true);
  });

  test("detects TLS/cert error messages", () => {
    expect(isTlsError(new Error("SSL handshake failed"))).toBe(true);
    expect(
      isTlsError(new Error("unable to verify the first certificate"))
    ).toBe(true);
    expect(isTlsError(new Error("write EPROTO wrong version number"))).toBe(
      true
    );
    expect(isTlsError(new Error("client certificate required"))).toBe(true);
  });

  test("reads nested cause for TLS markers", () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    };
    expect(isTlsError(err)).toBe(true);
  });

  test("walks multi-level nested cause chains", () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = {
      message: "connect error",
      cause: { message: "SSL handshake failure" },
    };
    expect(isTlsError(err)).toBe(true);
  });

  test("does not flag generic network errors", () => {
    expect(isTlsError(new Error("ECONNREFUSED connection refused"))).toBe(
      false
    );
    expect(isTlsError(new Error("getaddrinfo ENOTFOUND example.com"))).toBe(
      false
    );
    expect(isTlsError(undefined, 200)).toBe(false);
  });
});

describe("fetchPage TLS fallback (impersonation → standard fetch)", () => {
  test("falls back to standard fetch when impersonation throws a TLS error", async () => {
    mockStandardFetch(200, "<html>recovered</html>");
    const events: TlsEvent[] = [];

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: tlsFailingFetcher(),
        onTlsEvent: (e) => events.push(e),
      })
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("<html>recovered</html>");

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("fallback");
    expect(kinds).toContain("fallback_ok");
    const fallback = events.find((e) => e.kind === "fallback");
    expect(fallback?.fetcherId).toBe("browser-queue");
    // recoveredStatus carries the standard-fetch status only on fallback_ok.
    const recovered = events.find((e) => e.kind === "fallback_ok");
    expect(recovered?.recoveredStatus).toBe(200);
  });

  test("falls back when impersonation returns status 0", async () => {
    mockStandardFetch(200, "<html>via standard</html>");
    const events: TlsEvent[] = [];

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: statusZeroFetcher(),
        onTlsEvent: (e) => events.push(e),
      })
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("<html>via standard</html>");
    expect(events.some((e) => e.kind === "fallback_ok")).toBe(true);
  });

  test("detects redirects via the standard fallback fetch", async () => {
    // First call (impersonation) throws TLS; fallback standard fetch hits a 301
    // then a 200. fetchPage uses redirect:"manual", so it walks the chain.
    const responses: Response[] = [
      new Response(null, {
        status: 301,
        headers: { location: "https://example.com/final" },
      }),
      new Response("<html>final</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ];
    let call = 0;
    globalThis.fetch = (async () =>
      responses[call++]!) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: tlsFailingFetcher(),
      })
    );

    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://example.com/final");
    // hops includes every URL visited (source + target); chainLength counts the
    // redirect transitions between them (hops - 1).
    expect(result.redirectChain.hops.length).toBe(2);
    expect(result.redirectChain.chainLength).toBe(1);
  });

  test("emits no TLS events when the custom fetcher succeeds cleanly", async () => {
    const okFetcher: DocumentFetcher = {
      id: "browser-queue",
      capabilities: { jsRendering: true, cookies: true, screenshot: false },
      async fetch(req): Promise<FetchResponse> {
        return {
          url: req.url,
          finalUrl: req.url,
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html>ok</html>",
          timing: { startedAt: 0, responseAt: 5, finishedAt: 9 },
          redirectChain,
        };
      },
    };
    const events: TlsEvent[] = [];

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: okFetcher,
        onTlsEvent: (e) => events.push(e),
      })
    );

    expect(result.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  test("emits fallback_failed and fails when standard fetch also errors", async () => {
    globalThis.fetch = (async () => {
      throw new Error("certificate has expired");
    }) as unknown as typeof fetch;
    const events: TlsEvent[] = [];

    const outcome = await Effect.runPromise(
      Effect.either(
        // single-attempt impersonation path; fallback retries internally
        fetchPage("https://example.com", {
          userAgent: "ua",
          timeoutMs: 1000,
          followRedirects: true,
          fetcher: tlsFailingFetcher(),
          onTlsEvent: (e) => events.push(e),
        })
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect((outcome.left as CrawlError).type).toBe("tls");
    }
    const failed = events.find((e) => e.kind === "fallback_failed");
    expect(failed).toBeDefined();
    // Fallback also failed on TLS → never connected.
    expect(failed?.wasNeverConnected).toBe(true);
  });

  test("does not fall back on a normal HTTP error from impersonation", async () => {
    let standardCalled = false;
    globalThis.fetch = (async () => {
      standardCalled = true;
      return new Response("<html>should not be used</html>", { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher: DocumentFetcher = {
      id: "browser-queue",
      capabilities: { jsRendering: true, cookies: true, screenshot: false },
      async fetch(req): Promise<FetchResponse> {
        return {
          url: req.url,
          finalUrl: req.url,
          status: 429,
          headers: { "retry-after": "5" },
          body: "",
          timing: { startedAt: 0, responseAt: 1, finishedAt: 1 },
          redirectChain,
        };
      },
    };

    const outcome = await Effect.runPromise(
      Effect.either(
        fetchPage("https://example.com", {
          userAgent: "ua",
          timeoutMs: 1000,
          followRedirects: true,
          fetcher,
        })
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect((outcome.left as CrawlError).type).toBe("rate_limit");
    }
    // 429 is a real HTTP response, not a TLS failure → no standard fallback.
    expect(standardCalled).toBe(false);
  });

  test("returns the fallback's non-TLS error when the standard fetch is rate limited", async () => {
    // Impersonation fails on TLS → fallback to standard fetch, which gets a 429.
    // The returned error should be the fallback's rate_limit, not the original tls.
    globalThis.fetch = (async () =>
      new Response("", {
        status: 429,
        headers: { "retry-after": "7" },
      })) as unknown as typeof fetch;
    const events: TlsEvent[] = [];

    const outcome = await Effect.runPromise(
      Effect.either(
        fetchPage("https://example.com", {
          userAgent: "ua",
          timeoutMs: 1000,
          followRedirects: true,
          fetcher: tlsFailingFetcher(),
          onTlsEvent: (e) => events.push(e),
        })
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect((outcome.left as CrawlError).type).toBe("rate_limit");
    }
    const failed = events.find((e) => e.kind === "fallback_failed");
    expect(failed).toBeDefined();
    // Non-TLS fallback failure (got an HTTP status) → not "never connected".
    expect(failed?.wasNeverConnected).toBe(false);
  });
});

describe("fetchPageWithRetry retries TLS errors on the standard path", () => {
  test("recovers after a transient TLS error then a success", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        throw new Error("SSL routines: bad record mac");
      }
      return new Response("<html>ok after retry</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchPageWithRetry("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
      })
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("<html>ok after retry</html>");
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

describe("standard (non-impersonation) path emits TLS context on failure", () => {
  test("emits an 'error' TlsEvent when a no-fetcher TLS failure surfaces", async () => {
    globalThis.fetch = (async () => {
      throw new Error(" SSL routines: certificate verify failed");
    }) as unknown as typeof fetch;
    const events: TlsEvent[] = [];

    const outcome = await Effect.runPromise(
      Effect.either(
        fetchPage("https://example.com", {
          userAgent: "ua",
          timeoutMs: 1000,
          followRedirects: true,
          onTlsEvent: (e) => events.push(e),
        })
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect((outcome.left as CrawlError).type).toBe("tls");
    }
    const errorEvent = events.find((e) => e.kind === "error");
    expect(errorEvent).toBeDefined();
    // A thrown exception produced no HTTP status → never connected.
    expect(errorEvent?.wasNeverConnected).toBe(true);
  });
});
