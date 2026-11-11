// #1759: the compact resolution signal can carry the pages that redirected, as evidence for the findings
// that resolve on them. Bounded, malformed rows dropped, and the first thing given up when the byte
// budget bites, so it never costs a resolution.

import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";

import { RESOLUTION_SIGNAL_LIMITS } from "@squirrelscan/core-contracts/limits";
import type { CompactResolutionPayload } from "@squirrelscan/core-contracts/resolution";

import { buildCompactResolutionSignal } from "../src/resolution";
import { decodeResolutionSignal } from "../src/resolution-decode";

const rules = {
  "core/meta-title": {
    checks: [{ name: "meta-title", status: "fail", message: "m", pageUrl: "https://x.test/a" }],
  },
} as never;
const crawled = ["https://x.test/a", "https://x.test/old"];

describe("redirect evidence in the compact signal", () => {
  test("round-trips as redirectedUrls", async () => {
    const compact = buildCompactResolutionSignal(rules, crawled, undefined, [], {
      redirects: [{ url: "https://x.test/old", status: 301, to: "https://x.test/new" }],
    })!;
    const signal = await decodeResolutionSignal(compact);
    expect(signal.redirectedUrls).toEqual({
      "https://x.test/old": { status: 301, to: "https://x.test/new" },
    });
  });

  test("a signal built without redirects has no field", async () => {
    const signal = await decodeResolutionSignal(buildCompactResolutionSignal(rules, crawled)!);
    expect(signal.redirectedUrls).toBeUndefined();
  });

  test("bounded at the contract's cap, malformed rows left out", async () => {
    const many = Array.from({ length: RESOLUTION_SIGNAL_LIMITS.maxRedirects + 50 }, (_, i) => ({
      url: `https://x.test/r${i}`,
      status: 302,
      to: "https://x.test/t",
    }));
    const compact = buildCompactResolutionSignal(rules, crawled, undefined, [], {
      redirects: [
        { url: "https://x.test/ok", status: 301, to: "https://x.test/t" },
        { url: "https://x.test/200", status: 200, to: "https://x.test/t" },
        { url: 7 as never, status: 301, to: "https://x.test/t" },
        ...many,
      ],
    })!;
    const signal = await decodeResolutionSignal(compact);
    const urls = Object.keys(signal.redirectedUrls ?? {});
    expect(urls.length).toBe(RESOLUTION_SIGNAL_LIMITS.maxRedirects);
    expect(urls).toContain("https://x.test/ok");
    expect(urls).not.toContain("https://x.test/200");
  });

  test("a decoder drops hostile rows and a __proto__ source cannot reach the prototype", async () => {
    const payload = JSON.parse(
      inflateRawSync(Buffer.from(buildCompactResolutionSignal(rules, crawled)!.data, "base64")).toString(),
    ) as CompactResolutionPayload;
    payload.redirects = [
      ["__proto__", 301, "https://x.test/t"],
      ["https://x.test/bad", 99, "https://x.test/t"],
      ["https://x.test/bad2", 301, 5 as never],
    ];
    const { deflateRawSync } = await import("node:zlib");
    const data = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString("base64");
    const signal = await decodeResolutionSignal({ v: 1, data });
    expect(Object.keys(signal.redirectedUrls ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(signal.redirectedUrls)).toBe(Object.prototype);
  });

  test("only http(s) destinations are kept, on the way in and on the way out", async () => {
    const built = await decodeResolutionSignal(
      buildCompactResolutionSignal(rules, crawled, undefined, [], {
        redirects: [
          { url: "https://x.test/a", status: 301, to: "javascript:alert(1)" },
          { url: "https://x.test/b", status: 301, to: "data:text/html,x" },
          { url: "https://x.test/c", status: 301, to: "https://x.test/ok" },
        ],
      })!,
    );
    expect(Object.keys(built.redirectedUrls ?? {})).toEqual(["https://x.test/c"]);

    const payload = JSON.parse(
      inflateRawSync(Buffer.from(buildCompactResolutionSignal(rules, crawled)!.data, "base64")).toString(),
    ) as CompactResolutionPayload;
    payload.redirects = [
      ["https://x.test/a", 301, "javascript:alert(1)"],
      ["https://x.test/b", 301, `https://x.test/${"a".repeat(2100)}`],
      ["https://x.test/c", 301, "https://x.test/ok"],
    ];
    const { deflateRawSync } = await import("node:zlib");
    const data = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString("base64");
    const out = await decodeResolutionSignal({ v: 1, data });
    expect(Object.keys(out.redirectedUrls ?? {})).toEqual(["https://x.test/c"]);
  });

  test("when the budget bites, redirects go first and the pages keep their say", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      url: `https://x.test/${Math.random().toString(36)}-${i}`,
      status: 301,
      to: `https://x.test/${Math.random().toString(36)}`,
    }));
    const plain = buildCompactResolutionSignal(rules, crawled)!;
    const budget = JSON.stringify(plain).length + 40;
    const tight = buildCompactResolutionSignal(rules, crawled, budget, [], { redirects: many })!;
    const signal = await decodeResolutionSignal(tight);
    expect(signal.redirectedUrls).toBeUndefined();
    expect(signal.crawledUrls.length).toBe(2);
  });
});

describe("the count of recorded redirects survives a dropped list", () => {
  test("redirectsTotal rides alone when the list does not fit, and a clipped list keeps the true count", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      url: `https://x.test/${Math.random().toString(36)}-${i}`,
      status: 301,
      to: `https://x.test/${Math.random().toString(36)}`,
    }));
    const budget = JSON.stringify(buildCompactResolutionSignal(rules, crawled)!).length + 60;
    const dropped = await decodeResolutionSignal(
      buildCompactResolutionSignal(rules, crawled, budget, [], { redirects: many })!,
    );
    expect(dropped.redirectedUrls).toBeUndefined();
    expect(dropped.redirectedCount).toBe(400);

    const clipped = await decodeResolutionSignal(
      buildCompactResolutionSignal(rules, crawled, undefined, [], { redirects: many.slice(0, 5), redirectsTotal: 900 })!,
    );
    expect(Object.keys(clipped.redirectedUrls ?? {}).length).toBe(5);
    expect(clipped.redirectedCount).toBe(900);
  });

  test("a signal built without redirects has neither field", async () => {
    const signal = await decodeResolutionSignal(buildCompactResolutionSignal(rules, crawled)!);
    expect(signal.redirectedCount).toBeUndefined();
  });
});
