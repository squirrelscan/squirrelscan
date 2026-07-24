// Unit tests for the shared dependency-free Cache-Control parser + freshness
// lifetime calc (#146). Covers the behavior previously duplicated in
// @squirrelscan/crawler (incremental.ts) and @squirrelscan/rules (bad-caching).

import { describe, expect, test } from "bun:test";

import {
  cacheControlLifetimeSeconds,
  expiresLifetimeSeconds,
  parseCacheControl,
} from "../src/cache-control";

describe("parseCacheControl", () => {
  test("parses max-age, s-maxage, swr, immutable", () => {
    const cc = parseCacheControl(
      "public, max-age=600, s-maxage=1200, stale-while-revalidate=300, immutable"
    );
    expect(cc.maxAge).toBe(600);
    expect(cc.sMaxAge).toBe(1200);
    expect(cc.staleWhileRevalidate).toBe(300);
    expect(cc.immutable).toBe(true);
    expect(cc.noStore).toBe(false);
    expect(cc.noCache).toBe(false);
    expect(cc.mustRevalidate).toBe(false);
  });

  test("detects no-store / no-cache / must-revalidate / proxy-revalidate", () => {
    expect(parseCacheControl("no-store").noStore).toBe(true);
    expect(parseCacheControl("no-cache").noCache).toBe(true);
    expect(parseCacheControl("must-revalidate").mustRevalidate).toBe(true);
    expect(parseCacheControl("proxy-revalidate").mustRevalidate).toBe(true);
  });

  test("tolerates quoted values and whitespace/casing", () => {
    expect(parseCacheControl('max-age="900"').maxAge).toBe(900);
    expect(parseCacheControl("  MAX-AGE=42 ").maxAge).toBe(42);
    expect(parseCacheControl('s-maxage="7"').sMaxAge).toBe(7);
  });

  test("null / empty header → empty directives", () => {
    for (const input of [null, "", "   "]) {
      const cc = parseCacheControl(input);
      expect(cc.maxAge).toBeUndefined();
      expect(cc.sMaxAge).toBeUndefined();
      expect(cc.staleWhileRevalidate).toBeUndefined();
      expect(cc.noStore).toBe(false);
      expect(cc.noCache).toBe(false);
      expect(cc.mustRevalidate).toBe(false);
      expect(cc.immutable).toBe(false);
    }
  });

  test("negative / non-numeric max-age treated as absent", () => {
    expect(parseCacheControl("max-age=-5").maxAge).toBeUndefined();
    expect(parseCacheControl("max-age=abc").maxAge).toBeUndefined();
    expect(parseCacheControl("s-maxage=-1").sMaxAge).toBeUndefined();
  });

  test("max-age=0 is a valid zero lifetime", () => {
    expect(parseCacheControl("max-age=0").maxAge).toBe(0);
    expect(parseCacheControl("s-maxage=0").sMaxAge).toBe(0);
  });

  test("ignores unknown directives", () => {
    const cc = parseCacheControl("public, private, max-age=10");
    expect(cc.maxAge).toBe(10);
    expect(cc.noStore).toBe(false);
  });
});

describe("cacheControlLifetimeSeconds", () => {
  test("s-maxage takes precedence over max-age", () => {
    expect(
      cacheControlLifetimeSeconds(parseCacheControl("max-age=10, s-maxage=1000"))
    ).toBe(1000);
  });

  test("falls back to max-age when no s-maxage", () => {
    expect(cacheControlLifetimeSeconds(parseCacheControl("max-age=42"))).toBe(42);
  });

  test("s-maxage=0 overrides max-age (no usable lifetime)", () => {
    expect(
      cacheControlLifetimeSeconds(parseCacheControl("max-age=3600, s-maxage=0"))
    ).toBe(0);
  });

  test("undefined when neither present", () => {
    expect(cacheControlLifetimeSeconds(parseCacheControl("no-cache"))).toBeUndefined();
    expect(cacheControlLifetimeSeconds(parseCacheControl(null))).toBeUndefined();
  });
});

describe("expiresLifetimeSeconds", () => {
  const fetchedAt = 1_000_000_000_000;

  test("future Expires → positive lifetime relative to fetchedAt", () => {
    const expires = new Date(fetchedAt + 3600 * 1000).toUTCString();
    expect(expiresLifetimeSeconds(expires, fetchedAt)).toBeCloseTo(3600, 0);
  });

  test("past Expires clamps to 0 (never negative)", () => {
    const expires = new Date(fetchedAt - 10 * 1000).toUTCString();
    expect(expiresLifetimeSeconds(expires, fetchedAt)).toBe(0);
  });

  test("missing / unparseable Expires → undefined", () => {
    expect(expiresLifetimeSeconds(null, fetchedAt)).toBeUndefined();
    expect(expiresLifetimeSeconds("not-a-date", fetchedAt)).toBeUndefined();
  });
});
