// #973: extractResponseHeaders() (the crawler's own fork of the CLI's
// headersToRecord, per the "forked fetcher" split — packages/fetchers is the
// DocumentFetcher abstraction, this is the standard-fetch path fetchPage()
// falls back to) must keep every Set-Cookie header, not just the last one.
// Must survive a real multi-Set-Cookie response, not just a synthetic Headers
// object in isolation.

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { fetchPage } from "../src/fetcher";

const FETCH_OPTIONS = {
  userAgent: "test-agent",
  timeoutMs: 5_000,
  followRedirects: false,
};

describe("extractResponseHeaders Set-Cookie handling (#973)", () => {
  test("keeps every cookie, newline-joined, when a page sets more than one", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const headers = new Headers({ "Content-Type": "text/html" });
        headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
        headers.append(
          "Set-Cookie",
          "consent=1; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure",
        );
        return new Response("<!doctype html><title>t</title>", { headers });
      },
    });
    try {
      const result = await Effect.runPromise(
        fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS),
      );
      const setCookie = result.headers.setCookie ?? "";
      const cookies = setCookie.split("\n");
      expect(cookies).toHaveLength(2);
      expect(setCookie).toContain("session=abc123");
      expect(setCookie).toContain("consent=1");
    } finally {
      server.stop(true);
    }
  });

  test("no Set-Cookie header: null, not an empty string", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>t</title>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
    try {
      const result = await Effect.runPromise(
        fetchPage(`http://localhost:${server.port}/`, FETCH_OPTIONS),
      );
      expect(result.headers.setCookie).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
