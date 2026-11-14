// #3922: the hosted worker sets `requireProxy`; without a usable proxy the
// probe answers `unavailable` and opens no socket. The resolver throws if it
// is ever asked, which proves nothing was resolved or dialed either.

import { describe, expect, test } from "bun:test";

import { createTlsProbe } from "./index";

const noResolve = async (): Promise<string[]> => {
  throw new Error("resolver must not be called");
};

describe("createTlsProbe requireProxy (#3922)", () => {
  test("no proxy applies: unavailable, nothing resolved", async () => {
    const probe = createTlsProbe({ requireProxy: true, resolve: noResolve });
    const result = await probe({ hostname: "example.com" });
    expect(result.kind).toBe("unavailable");
  });

  test("an unusable proxy URL is unavailable, not a direct socket", async () => {
    const probe = createTlsProbe({
      requireProxy: true,
      proxyUrl: "socks5://127.0.0.1:1",
      resolve: noResolve,
    });
    const result = await probe({ hostname: "example.com" });
    expect(result.kind).toBe("unavailable");
  });

  test("a refused address stays refused through the proxy path", async () => {
    const probe = createTlsProbe({
      requireProxy: true,
      proxyUrl: "http://127.0.0.1:9",
      resolve: async () => ["169.254.169.254"],
    });
    const result = await probe({ hostname: "example.com" });
    expect(result).toMatchObject({ kind: "unreachable", code: "EGRESS_REFUSED" });
  });
});
