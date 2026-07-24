// Unit tests for browser-like freshness + Vary keying (#106).

import { describe, expect, test } from "bun:test";

import {
  calculateFreshness,
  parseCacheControl,
  parseVary,
  varyMatches,
} from "../src/incremental";

const SEC = 1000;
const now = 1_000_000_000_000; // fixed clock

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
  });

  test("detects no-store / no-cache / must-revalidate", () => {
    expect(parseCacheControl("no-store").noStore).toBe(true);
    expect(parseCacheControl("no-cache").noCache).toBe(true);
    expect(parseCacheControl("must-revalidate").mustRevalidate).toBe(true);
  });

  test("tolerates quoted values and whitespace", () => {
    expect(parseCacheControl('max-age="900"').maxAge).toBe(900);
    expect(parseCacheControl("  MAX-AGE=42 ").maxAge).toBe(42);
  });

  test("null header → empty directives", () => {
    const cc = parseCacheControl(null);
    expect(cc.maxAge).toBeUndefined();
    expect(cc.noStore).toBe(false);
  });
});

describe("calculateFreshness", () => {
  test("max-age: fresh within lifetime (skip request)", () => {
    const r = calculateFreshness(
      { cacheControl: "max-age=3600", expires: null, age: null, fetchedAt: now - 1800 * SEC },
      { now }
    );
    expect(r.state).toBe("fresh");
    expect(r.reason).toBe("max-age");
  });

  test("max-age: stale past lifetime → conditional GET", () => {
    const r = calculateFreshness(
      { cacheControl: "max-age=3600", expires: null, age: null, fetchedAt: now - 7200 * SEC },
      { now }
    );
    expect(r.state).toBe("stale");
  });

  test("Age header counts toward current age", () => {
    // max-age=100, stored 60s ago, but response Age was 80 → total 140 > 100.
    const r = calculateFreshness(
      { cacheControl: "max-age=100", expires: null, age: 80, fetchedAt: now - 60 * SEC },
      { now }
    );
    expect(r.state).toBe("stale");
  });

  test("no-store / no-cache always revalidate", () => {
    expect(
      calculateFreshness(
        { cacheControl: "no-store, max-age=3600", expires: null, age: null, fetchedAt: now },
        { now }
      ).state
    ).toBe("stale");
    expect(
      calculateFreshness(
        { cacheControl: "no-cache", expires: null, age: null, fetchedAt: now },
        { now }
      ).state
    ).toBe("stale");
  });

  test("Expires fallback when no max-age", () => {
    const expires = new Date(now + 3600 * SEC).toUTCString();
    const r = calculateFreshness(
      { cacheControl: null, expires, age: null, fetchedAt: now },
      { now }
    );
    expect(r.state).toBe("fresh");
    expect(r.reason).toBe("expires");
  });

  test("Age header counts against an Expires-only lifetime", () => {
    // lifetime = (expiresMs - fetchedAt)/1000. expires=now+100s,
    // fetchedAt=now-60s → lifetime=160s. ageSeconds = responseAge(120) +
    // localAge(60) = 180 > 160 → stale, even though Expires is in the future.
    const expires = new Date(now + 100 * SEC).toUTCString();
    const stale = calculateFreshness(
      { cacheControl: null, expires, age: 120, fetchedAt: now - 60 * SEC },
      { now }
    );
    expect(stale.state).toBe("stale");
    // Control: same entry with no response Age is still fresh (60 < 160).
    const fresh = calculateFreshness(
      { cacheControl: null, expires, age: 0, fetchedAt: now - 60 * SEC },
      { now }
    );
    expect(fresh.state).toBe("fresh");
    expect(fresh.reason).toBe("expires");
  });

  test("expired Expires → stale", () => {
    const expires = new Date(now - 10 * SEC).toUTCString();
    const r = calculateFreshness(
      { cacheControl: null, expires, age: null, fetchedAt: now - 20 * SEC },
      { now }
    );
    expect(r.state).toBe("stale");
  });

  test("no freshness info → stale", () => {
    const r = calculateFreshness(
      { cacheControl: null, expires: null, age: null, fetchedAt: now },
      { now }
    );
    expect(r.state).toBe("stale");
    expect(r.reason).toBe("no-cache-header");
  });

  test("staleness cap overrides absurd max-age", () => {
    // max-age = 10 years, stored 2 days ago, cap = 1 day → must revalidate.
    const r = calculateFreshness(
      {
        cacheControl: `max-age=${10 * 365 * 24 * 3600}`,
        expires: null,
        age: null,
        fetchedAt: now - 2 * 24 * 3600 * SEC,
      },
      { now, maxStalenessSeconds: 24 * 3600 }
    );
    expect(r.state).toBe("stale");
    expect(r.reason).toBe("staleness-cap");
  });

  test("immutable within lifetime is fresh", () => {
    const r = calculateFreshness(
      {
        cacheControl: "public, max-age=31536000, immutable",
        expires: null,
        age: null,
        fetchedAt: now - 3600 * SEC,
      },
      { now }
    );
    expect(r.state).toBe("fresh");
    expect(r.reason).toBe("immutable");
  });

  test("s-maxage takes precedence over max-age", () => {
    // max-age=10 (stale), s-maxage=10000 (fresh) → fresh via s-maxage.
    const r = calculateFreshness(
      { cacheControl: "max-age=10, s-maxage=10000", expires: null, age: null, fetchedAt: now - 100 * SEC },
      { now }
    );
    expect(r.state).toBe("fresh");
    expect(r.reason).toBe("s-maxage");
  });

  test("stale-while-revalidate: serve stale + revalidate", () => {
    // max-age=60, swr=600, stored 120s ago → 60s stale, within swr window.
    const r = calculateFreshness(
      {
        cacheControl: "max-age=60, stale-while-revalidate=600",
        expires: null,
        age: null,
        fetchedAt: now - 120 * SEC,
      },
      { now }
    );
    expect(r.state).toBe("revalidate");
    expect(r.reason).toBe("stale-while-revalidate");
  });

  test("swr suppressed by must-revalidate", () => {
    const r = calculateFreshness(
      {
        cacheControl: "max-age=60, stale-while-revalidate=600, must-revalidate",
        expires: null,
        age: null,
        fetchedAt: now - 120 * SEC,
      },
      { now }
    );
    expect(r.state).toBe("stale");
  });

  test("swr beyond window → stale", () => {
    // 700s stale, swr=600 → past the window.
    const r = calculateFreshness(
      {
        cacheControl: "max-age=60, stale-while-revalidate=600",
        expires: null,
        age: null,
        fetchedAt: now - 760 * SEC,
      },
      { now }
    );
    expect(r.state).toBe("stale");
  });
});

describe("Vary keying", () => {
  test("parseVary handles list and wildcard", () => {
    expect(parseVary("Accept-Encoding, User-Agent")).toEqual([
      "accept-encoding",
      "user-agent",
    ]);
    expect(parseVary("*")).toBe("*");
    expect(parseVary(null)).toEqual([]);
  });

  test("parseVary treats * anywhere in the list as uncacheable", () => {
    expect(parseVary("Accept-Encoding, *")).toBe("*");
    // and varyMatches forces a miss for it
    expect(varyMatches("Accept-Encoding, *", {}, {})).toBe(false);
  });

  test("no Vary header → always matches", () => {
    expect(varyMatches(null, null, { "user-agent": "x" })).toBe(true);
  });

  test("Vary: * never matches (uncacheable)", () => {
    expect(varyMatches("*", { "user-agent": "x" }, { "user-agent": "x" })).toBe(
      false
    );
  });

  test("matching varied header → hit", () => {
    expect(
      varyMatches(
        "Accept-Encoding",
        { "accept-encoding": "gzip, br" },
        { "accept-encoding": "gzip, br" }
      )
    ).toBe(true);
  });

  test("mismatched varied header → miss", () => {
    expect(
      varyMatches(
        "User-Agent",
        { "user-agent": "SquirrelBot/1.0" },
        { "user-agent": "SquirrelBot/2.0" }
      )
    ).toBe(false);
  });

  test("missing stored header treated as empty (miss when current present)", () => {
    expect(
      varyMatches("User-Agent", {}, { "user-agent": "SquirrelBot/2.0" })
    ).toBe(false);
  });
});
