import type { DocumentFetcher } from "@squirrelscan/fetchers";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchPage } from "../../src/crawler/fetcher";

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

describe("crawler fetcher with document fetcher", () => {
  test("maps custom document fetcher output", async () => {
    const customFetcher: DocumentFetcher = {
      id: "custom",
      capabilities: {
        jsRendering: true,
        cookies: true,
        screenshot: false,
      },
      async fetch(req) {
        return {
          url: req.url,
          finalUrl: req.url,
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-length": "11",
            server: "test",
          },
          body: "hello world",
          timing: {
            startedAt: 0,
            responseAt: 5,
            finishedAt: 9,
          },
          redirectChain,
        };
      },
    };

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: customFetcher,
      })
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe("hello world");
    expect(result.contentType).toBe("text/html");
    expect(result.sizeBytes).toBe(11);
    expect(result.ttfb).toBe(5);
    expect(result.downloadTime).toBe(4);
    expect(result.headers.server).toBe("test");
  });

  test("preserves status guard behavior for custom fetcher", async () => {
    const rateLimitedFetcher: DocumentFetcher = {
      id: "custom",
      capabilities: {
        jsRendering: false,
        cookies: true,
        screenshot: false,
      },
      async fetch(req) {
        return {
          url: req.url,
          finalUrl: req.url,
          status: 429,
          headers: { "retry-after": "12" },
          body: "",
          timing: {
            startedAt: 0,
            responseAt: 1,
            finishedAt: 1,
          },
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
          fetcher: rateLimitedFetcher,
        })
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left.type).toBe("rate_limit");
    }
  });

  test("normalizes malformed server-timing header values", async () => {
    const customFetcher: DocumentFetcher = {
      id: "custom",
      capabilities: {
        jsRendering: true,
        cookies: true,
        screenshot: false,
      },
      async fetch(req) {
        return {
          url: req.url,
          finalUrl: req.url,
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "server-timing":
              'cfCacheStatus;desc="DYNAMIC" cfEdge;dur=6,cfOrigin;dur=390',
          },
          body: "ok",
          timing: {
            startedAt: 0,
            responseAt: 5,
            finishedAt: 10,
          },
          redirectChain,
        };
      },
    };

    const result = await Effect.runPromise(
      fetchPage("https://example.com", {
        userAgent: "ua",
        timeoutMs: 1000,
        followRedirects: true,
        fetcher: customFetcher,
      })
    );

    expect(result.status).toBe(200);
    expect(result.headers.serverTiming).toBe(
      'cfCacheStatus;desc="DYNAMIC",cfEdge;dur=6,cfOrigin;dur=390'
    );
  });
});
