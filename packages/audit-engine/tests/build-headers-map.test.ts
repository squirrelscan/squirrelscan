// #748 — `buildHeadersMap` is the seam between a stored page's typed
// `headers`/`securityHeaders` and the loose `Record<string, string>` rules
// read via `ctx.page.headers`. A header field added to the storage type but
// never surfaced here makes any rule reading it silently inert against real
// crawled pages, even though unit tests constructing `ctx.page.headers`
// directly (bypassing this seam) would still pass — exactly what happened
// when security/cookie-flags was first added without this wiring.

import { describe, expect, test } from "bun:test";
import type { PageRecord } from "@squirrelscan/core-contracts";
import { buildHeadersMap, recordsVersionHeaders } from "../src/adapter";

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

  // #713 — security/version-disclosure reads these from ctx.page.headers; before
  // the passthrough only `server` reached rules.
  test("version-revealing headers reach rules alongside server (#713)", () => {
    const record = page({
      server: "Apache/2.4.41 (Ubuntu)",
      xPoweredBy: "PHP/7.4.3",
      xAspNetVersion: "4.0.30319",
      xAspNetMvcVersion: "5.2",
      xGenerator: "WordPress 6.2.1",
    });
    const headers = buildHeadersMap(record);
    expect(headers["server"]).toBe("Apache/2.4.41 (Ubuntu)");
    expect(headers["x-powered-by"]).toBe("PHP/7.4.3");
    expect(headers["x-aspnet-version"]).toBe("4.0.30319");
    expect(headers["x-aspnetmvc-version"]).toBe("5.2");
    expect(headers["x-generator"]).toBe("WordPress 6.2.1");
  });

  test("absent version-revealing headers stay out of the map", () => {
    const headers = buildHeadersMap(page());
    expect(headers["x-powered-by"]).toBeUndefined();
    expect(headers["x-generator"]).toBeUndefined();
  });

  // A record the crawler wrote since #713 has the field, null when not sent; a
  // record stored before has no key, and version-disclosure must not pass on it.
  test("recordsVersionHeaders tells a not-sent header from a record that predates it", () => {
    expect(recordsVersionHeaders(page({ xPoweredBy: null }))).toBe(true);
    expect(recordsVersionHeaders(page({ xPoweredBy: "PHP/8.1.2" }))).toBe(true);
    expect(recordsVersionHeaders(page())).toBe(false);
  });

  // pub#674: the store keeps the media type and the charset apart; rules read
  // them joined, as the server sent them. A record stored before the field
  // existed has no key and reads as before.
  test("content-type carries the stored charset; a record without one reads as before", () => {
    expect(buildHeadersMap(page({ contentType: "text/html", contentTypeCharset: "UTF-8" }))["content-type"]).toBe(
      "text/html; charset=UTF-8"
    );
    expect(buildHeadersMap(page({ contentType: "text/html", contentTypeCharset: null }))["content-type"]).toBe("text/html");
    expect(buildHeadersMap(page({ contentType: "text/html" }))["content-type"]).toBe("text/html");
    // No media type, no content-type at all, charset or not.
    expect(buildHeadersMap(page({ contentTypeCharset: "utf-8" }))["content-type"]).toBeUndefined();
  });
});
