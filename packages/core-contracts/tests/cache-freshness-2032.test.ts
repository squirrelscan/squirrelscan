import { describe, expect, test } from "bun:test";

import { MAX_STALE_CACHE_PAGES, buildCacheFreshness, staleCacheSignal } from "../src/cache-stats";

describe("staleCacheSignal (#2032)", () => {
  test("a positive Age is a cached response", () => {
    expect(staleCacheSignal({ age: "120" })).toBe("Age: 120");
  });
  test("Age 0 and no signals are not", () => {
    expect(staleCacheSignal({ age: "0", xCache: "MISS", cfCacheStatus: "DYNAMIC" })).toBeNull();
    expect(staleCacheSignal({})).toBeNull();
    expect(staleCacheSignal(null)).toBeNull();
  });
  test("HIT and STALE cache-status headers count, MISS does not", () => {
    expect(staleCacheSignal({ cfCacheStatus: "HIT" })).toBe("cf-cache-status: HIT");
    expect(staleCacheSignal({ xVercelCache: "STALE" })).toBe("x-vercel-cache: STALE");
    expect(staleCacheSignal({ xCache: "Hit from cloudfront" })).toBe(
      "x-cache: Hit from cloudfront",
    );
    expect(staleCacheSignal({ xCache: "Miss from cloudfront" })).toBeNull();
  });
});

describe("buildCacheFreshness (#2032)", () => {
  test("null when neither no-cache nor fresh render applies", () => {
    expect(buildCacheFreshness({ noCache: false, freshRender: false }, [])).toBeNull();
  });
  test("noCache lists stale pages with a true count past the cap", () => {
    const pages = Array.from({ length: MAX_STALE_CACHE_PAGES + 5 }, (_, i) => ({
      url: `https://e.com/${i}`,
      signal: "Age: 5",
    }));
    const note = buildCacheFreshness({ noCache: true, freshRender: false }, pages);
    expect(note?.stalePageCount).toBe(MAX_STALE_CACHE_PAGES + 5);
    expect(note?.stalePages).toHaveLength(MAX_STALE_CACHE_PAGES);
  });
  test("freshRender alone carries the statement and no stale pages", () => {
    const note = buildCacheFreshness({ noCache: false, freshRender: true }, [
      { url: "u", signal: "Age: 1" },
    ]);
    expect(note).toEqual({ noCache: false, freshRender: true, stalePageCount: 0, stalePages: [] });
  });
});
