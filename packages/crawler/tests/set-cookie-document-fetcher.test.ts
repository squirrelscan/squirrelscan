// #973 follow-up: fetchPage's custom-fetcher path (fetchWithDocumentFetcher,
// used by both the CLI impersonation fetcher and the cloud/browser-queue
// render fetcher) round-trips a DocumentFetcher's `Record<string,string>`
// response headers back through a real `Headers` object via
// headersFromRecord() before re-extracting them. setHeaderSafely() strips
// \r\n from every header value to guard against header injection, which — if
// set-cookie weren't special-cased — would collapse the "\n"-joined
// multi-cookie shape from packages/fetchers / apps/crawler-worker into one
// corrupted, space-joined cookie. This proves the round-trip preserves every
// cookie.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { DocumentFetcher, FetchResponse } from "@squirrelscan/fetchers";

import { fetchPage } from "../src/fetcher";

const FETCH_OPTIONS_BASE = {
  userAgent: "test-agent",
  timeoutMs: 5_000,
  followRedirects: false,
};

function fakeDocumentFetcher(headers: Record<string, string>): DocumentFetcher {
  return {
    id: "fake",
    capabilities: { jsRendering: false, cookies: true, screenshot: false },
    async fetch(req): Promise<FetchResponse> {
      return {
        url: req.url,
        finalUrl: req.url,
        status: 200,
        headers,
        body: "<!doctype html><title>t</title>",
        timing: { startedAt: 0, responseAt: 1, finishedAt: 2 },
        redirectChain: {
          sourceUrl: req.url,
          finalUrl: req.url,
          hops: [],
          chainLength: 0,
          isLoop: false,
          endsInError: false,
          httpsToHttp: false,
          httpToHttps: false,
        },
        fetcherMethod: "fake",
      };
    },
  };
}

describe("fetchWithDocumentFetcher Set-Cookie round-trip (#973)", () => {
  test("preserves every cookie through the Record -> Headers -> Record round-trip", async () => {
    const fetcher = fakeDocumentFetcher({
      "content-type": "text/html",
      "set-cookie": "session=abc123; Path=/; HttpOnly\nconsent=1; Path=/; Secure",
    });

    const result = await Effect.runPromise(
      fetchPage("https://example.com/", { ...FETCH_OPTIONS_BASE, fetcher }),
    );

    const setCookie = result.headers.setCookie ?? "";
    const cookies = setCookie.split("\n");
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe("session=abc123; Path=/; HttpOnly");
    expect(cookies[1]).toBe("consent=1; Path=/; Secure");
  });

  test("preserves three cookies, none merged or dropped", async () => {
    const fetcher = fakeDocumentFetcher({
      "set-cookie": [
        "session=abc123; Path=/; HttpOnly",
        "csrftoken=xyz789; Path=/; Secure",
        "optout=1; Path=/; Max-Age=31536000",
      ].join("\n"),
    });

    const result = await Effect.runPromise(
      fetchPage("https://example.com/", { ...FETCH_OPTIONS_BASE, fetcher }),
    );

    const cookies = (result.headers.setCookie ?? "").split("\n");
    expect(cookies).toHaveLength(3);
    expect(cookies.map((c) => c.split("=")[0])).toEqual(["session", "csrftoken", "optout"]);
  });

  test("no Set-Cookie: null, not an empty string", async () => {
    const fetcher = fakeDocumentFetcher({ "content-type": "text/html" });
    const result = await Effect.runPromise(
      fetchPage("https://example.com/", { ...FETCH_OPTIONS_BASE, fetcher }),
    );
    expect(result.headers.setCookie).toBeNull();
  });

  test("other headers are unaffected by the Set-Cookie special-casing", async () => {
    const fetcher = fakeDocumentFetcher({
      "content-type": "text/html",
      "set-cookie": "a=1",
    });
    const result = await Effect.runPromise(
      fetchPage("https://example.com/", { ...FETCH_OPTIONS_BASE, fetcher }),
    );
    expect(result.contentType).toBe("text/html");
    expect(result.headers.setCookie).toBe("a=1");
  });
});
