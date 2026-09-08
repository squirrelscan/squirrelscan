// The two pure halves of the rule-result cache (#1990): the hash the key is built
// from, and the codec the payload survives a round-trip through.
//
// Both are places where being SUBTLY wrong is worse than failing: a canonical form
// that collapses two different run contexts to one string replays the wrong
// verdicts, and a codec that turns a `Set` into `{}` silently empties the template
// fingerprint every replayed page contributes to `template-discontinuity`.

import { describe, expect, test } from "bun:test";

import {
  canonicalJson,
  computeRunContextHash,
  decodeCacheValue,
  decodePageRuleCacheEntry,
  encodeCacheValue,
  encodePageRuleCacheEntry,
  sha256Hex,
} from "../src/rule-cache";

describe("sha256Hex", () => {
  // Published NIST vectors. The point is not that SHA-256 works, it is that this
  // wrapper's byte handling does — a TextEncoder or hex-padding slip would give a
  // stable but wrong digest, which no round-trip test can see.
  test("matches the published vectors", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is sensitive to non-ASCII bytes", async () => {
    expect(await sha256Hex("é")).not.toBe(await sha256Hex("e"));
  });
});

describe("canonicalJson", () => {
  test("is insensitive to key order and sensitive to everything else", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("distinguishes an absent key from an undefined one", () => {
    expect(canonicalJson({ a: undefined })).not.toBe(canonicalJson({}));
  });

  test("keeps Set and Map iteration order, which is observable", () => {
    expect(canonicalJson(new Set(["a", "b"]))).not.toBe(canonicalJson(new Set(["b", "a"])));
    expect(canonicalJson(new Map([["a", 1]]))).not.toBe(canonicalJson({ a: 1 }));
  });

  // Three inputs that a single "not finite" token would have merged, and two
  // arrays that a hole-skipping `.map` would have. A rule option distinguishing
  // any of these pairs would otherwise change behaviour under an unchanged key.
  test("does not merge distinct numbers or array shapes", () => {
    const forms = [NaN, Infinity, -Infinity].map((n) => canonicalJson({ limit: n }));
    expect(new Set(forms).size).toBe(3);
    expect(canonicalJson([])).not.toBe(canonicalJson(new Array(1)));
    expect(canonicalJson([undefined])).toBe(canonicalJson(new Array(1)));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([12]));
  });

  // The reason this throws rather than degrading: a run context holding a live
  // handle must not hash to the same string as one holding a different live
  // handle. The callers turn the throw into "no cache this run".
  test("throws on anything that is not plain data", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow();
    expect(() => canonicalJson({ r: /x/ })).toThrow();
    class Handle {
      lookup() {
        return 1;
      }
    }
    expect(() => canonicalJson({ intel: new Handle() })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });
});

describe("cache payload codec", () => {
  test("round-trips a Set, which plain JSON would empty", () => {
    const value = { assetHosts: new Set(["a.test", "b.test"]) };
    const back = decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))) as typeof value;
    expect(back.assetHosts).toBeInstanceOf(Set);
    expect([...back.assetHosts]).toEqual(["a.test", "b.test"]);
    // The failure this exists to stop: without tagging, the Set is `{}`.
    expect(JSON.parse(JSON.stringify(value)).assetHosts).toEqual({});
  });

  test("round-trips Maps, undefined, null and nesting", () => {
    const value = {
      m: new Map<string, unknown>([["k", { deep: new Set([1]) }]]),
      u: undefined,
      n: null,
      list: [1, "two", { three: undefined }],
    };
    const back = decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))) as typeof value;
    expect(back.m).toBeInstanceOf(Map);
    expect((back.m.get("k") as { deep: Set<number> }).deep).toBeInstanceOf(Set);
    expect("u" in back).toBe(true);
    expect(back.u).toBeUndefined();
    expect(back.n).toBeNull();
    expect(back.list).toEqual([1, "two", { three: undefined }]);
  });

  // A rule is free to put whatever it likes in `check.details`, including a key
  // that collides with a tag. Escaping is what keeps that from decoding as a Set.
  test("survives a data object whose own key looks like a tag", () => {
    const value = { details: { $s: ["not-a-set"], $m: 1, $u: "text" } };
    const back = decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))) as typeof value;
    expect(back).toEqual(value);
    expect(back.details.$s).toEqual(["not-a-set"]);
  });

  test("an entry round-trips through the stored string form", () => {
    const entry = {
      ruleResults: [
        ["core/title", [{ name: "title-present", status: "pass" as const, message: "ok" }]],
        [
          "core/meta",
          [
            {
              name: "description",
              status: "fail" as const,
              message: "missing",
              value: 42,
              details: { pages: ["/a"] },
            },
          ],
        ],
      ] as const,
      features: { normalizedUrl: "/a", status: 200, depth: 0 } as never,
      signals: { "site-dom-signals": { url: "/a", fingerprint: { assetHosts: new Set(["x"]) } } },
    };
    const back = decodePageRuleCacheEntry(encodePageRuleCacheEntry(entry as never));
    expect(back).not.toBeNull();
    // The number stays a number. `rule_results` cannot serve as this cache
    // precisely because it stores value through String().
    expect(back!.ruleResults[1]![1][0]!.value).toBe(42);
    const signal = back!.signals["site-dom-signals"] as { fingerprint: { assetHosts: Set<string> } };
    expect(signal.fingerprint.assetHosts).toBeInstanceOf(Set);
  });

  // `JSON.stringify` renders a Date as an ISO string on a fresh run; walked as a
  // plain object it has no own keys and would come back `{}`. `check.details` is
  // `Record<string, unknown>`, so a rule may put one there.
  test("round-trips a Date, which a plain-object walk would empty", () => {
    const value = { details: { when: new Date("2026-01-01T00:00:00.000Z") } };
    const back = decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))) as typeof value;
    expect(back.details.when).toBeInstanceOf(Date);
    expect(JSON.stringify(back)).toBe(JSON.stringify(value));
  });

  // `JSON.parse` makes `__proto__` an ordinary own key, but `out[k] = v` routes it
  // to the prototype setter and it disappears.
  test("keeps an own __proto__ key through the round-trip", () => {
    const value = JSON.parse('{"details":{"__proto__":"kept","other":1}}') as {
      details: Record<string, unknown>;
    };
    const back = decodeCacheValue(JSON.parse(JSON.stringify(encodeCacheValue(value)))) as typeof value;
    expect(Object.hasOwn(back.details, "__proto__")).toBe(true);
    expect(JSON.stringify(back)).toBe(JSON.stringify(value));
  });

  test("an unreadable payload is a miss, not a throw", () => {
    expect(decodePageRuleCacheEntry("{not json")).toBeNull();
    expect(decodePageRuleCacheEntry(JSON.stringify({ nothing: true }))).toBeNull();
  });
});

describe("run context", () => {
  const base = {
    engineVersion: "0.0.91",
    pageRules: [{ id: "core/meta-title", options: { max_length: 75 } }],
    siteData: { baseUrl: "http://x.test", pages: [], robotsTxt: null, sitemaps: null } as never,
    siteMetadata: undefined,
    cloudResults: undefined,
    ignoreApplicability: false,
    utcYear: 2026,
  };
  const hashOf = async (over: Partial<typeof base>) => {
    const out = await computeRunContextHash({ ...base, ...over });
    if (!("hash" in out)) throw new Error(`disabled: ${out.disabled}`);
    return out.hash;
  };

  test("is stable for the same inputs", async () => {
    expect(await hashOf({})).toBe(await hashOf({}));
  });

  // `content/stale-copyright` reads `new Date().getUTCFullYear()` at execution, so
  // a pass cached on 31 December must not replay on 1 January.
  test("moves with the UTC year", async () => {
    expect(await hashOf({ utcYear: 2027 })).not.toBe(await hashOf({}));
  });

  // The escape hatch changes a gated rule from a `skipped` check to its real
  // verdict without touching the rule list or any rule's options.
  test("moves with the applicability escape hatch", async () => {
    expect(await hashOf({ ignoreApplicability: true })).not.toBe(await hashOf({}));
  });

  test("moves with the build, the rule list and a rule's options", async () => {
    expect(await hashOf({ engineVersion: "0.0.92" })).not.toBe(await hashOf({}));
    expect(await hashOf({ pageRules: [] })).not.toBe(await hashOf({}));
    expect(
      await hashOf({ pageRules: [{ id: "core/meta-title", options: { max_length: 12 } }] }),
    ).not.toBe(await hashOf({}));
  });

  // Fail CLOSED: a run context holding something that is not plain data must not
  // hash to a value it shares with a different one.
  test("refuses to hash a live handle", async () => {
    class IntelHandle {
      lookupUrl() {
        return null;
      }
    }
    const out = await computeRunContextHash({ ...base, siteMetadata: new IntelHandle() });
    expect(out).toEqual({ disabled: "unhashable-run-context" });
  });
});
