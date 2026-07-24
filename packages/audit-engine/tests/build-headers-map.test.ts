// #748 — `buildHeadersMap` is the seam between a stored page's typed
// `headers`/`securityHeaders` and the loose `Record<string, string>` rules
// read via `ctx.page.headers`. A header field added to the storage type but
// never surfaced here makes any rule reading it silently inert against real
// crawled pages, even though unit tests constructing `ctx.page.headers`
// directly (bypassing this seam) would still pass — exactly what happened
// when security/cookie-flags was first added without this wiring.

import { describe, expect, test } from "bun:test";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { buildHeadersMap } from "../src/adapter";

function page(overrides: Partial<PageRecord["headers"]> = {}): PageRecord {
  return {
    url: "https://example.com/",
    normalizedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    depth: 0,
    status: 200,
    contentType: "text/html",
    sizeBytes: 0,
    loadTimeMs: 0,
    fetchedAt: 0,
    etag: null,
    lastModified: null,
    contentHash: "",
    html: "<!doctype html>",
    parsedData: null,
    headers: {
      contentType: null,
      contentEncoding: null,
      cacheControl: null,
      vary: null,
      etag: null,
      server: null,
      lastModified: null,
      link: null,
      serverTiming: null,
      age: null,
      xCache: null,
      cfCacheStatus: null,
      xVercelCache: null,
      altSvc: null,
      acceptRanges: null,
      ...overrides,
    },
    securityHeaders: {
      hsts: null,
      csp: null,
      xFrameOptions: null,
      xContentTypeOptions: null,
      referrerPolicy: null,
      permissionsPolicy: null,
      xRobotsTag: null,
    },
  } as unknown as PageRecord;
}

describe("buildHeadersMap", () => {
  test("surfaces set-cookie into ctx.page.headers when present", () => {
    const record = page({ setCookie: "session=abc123; Path=/; HttpOnly; Secure" });
    const headers = buildHeadersMap(record);
    expect(headers["set-cookie"]).toBe("session=abc123; Path=/; HttpOnly; Secure");
  });

  test("multi-cookie set-cookie value passes through intact", () => {
    const value = "a=1; Path=/, b=2; Path=/; Secure";
    const record = page({ setCookie: value });
    const headers = buildHeadersMap(record);
    expect(headers["set-cookie"]).toBe(value);
  });

  test("no set-cookie: absent from the map, not an empty string", () => {
    const record = page();
    const headers = buildHeadersMap(record);
    expect(headers["set-cookie"]).toBeUndefined();
  });

  test("existing headers still surface correctly (no regression from the hoist)", () => {
    const record = page({ contentType: "text/html", etag: "abc" });
    const headers = buildHeadersMap(record);
    expect(headers["content-type"]).toBe("text/html");
    expect(headers["etag"]).toBe("abc");
  });
});
