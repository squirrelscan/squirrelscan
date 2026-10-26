// squirrelscan/repo#2861: the hash sets a published report carries per link
// rule, and the one hash both sides use to test a target against them.

import { describe, expect, test } from "bun:test";

import {
  decodeLinkTargetSet,
  encodeLinkTargetSet,
  LINK_TARGET_SET_MAX_HASHES,
  linkTargetHash,
} from "../src/link-target-set";

describe("linkTargetHash", () => {
  test("hashes a target query-blind: host case, trailing slash, query and fragment ignored", () => {
    const base = linkTargetHash("https://example.com/a/b");
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(linkTargetHash("HTTPS://Example.COM/a/b/")).toBe(base);
    expect(linkTargetHash("https://example.com/a/b#top")).toBe(base);
    // A link that only changed its tracking parameters is the same link.
    expect(linkTargetHash("https://example.com/a/b?utm_source=old")).toBe(base);
    // The path's case is the target's.
    expect(linkTargetHash("https://example.com/a/B")).not.toBe(base);
  });

  test("is the same on every run (a fixed function, not seeded per process)", () => {
    expect(linkTargetHash("https://example.com/")).toBe(linkTargetHash("https://example.com/"));
    // The FNV-1a 64 offset basis: the hash of nothing.
    expect(linkTargetHash("")).toBe("cbf29ce484222325"); // pragma: allowlist secret
  });
});

describe("encodeLinkTargetSet and decodeLinkTargetSet", () => {
  const urls = Array.from({ length: 25 }, (_, i) => `https://example.com/p${i}`);

  test("round-trip: every target in, nothing else", () => {
    const set = encodeLinkTargetSet(urls);
    expect(set).toMatchObject({ count: 25, complete: true });
    const decoded = decodeLinkTargetSet(set)!;
    expect(decoded.size).toBe(25);
    for (const url of urls) expect(decoded.has(linkTargetHash(url))).toBe(true);
    expect(decoded.has(linkTargetHash("https://example.com/other"))).toBe(false);
  });

  test("de-duplicates and sorts, so the same targets give the same bytes in any order", () => {
    const forward = encodeLinkTargetSet([...urls, urls[0]!, `${urls[1]}/`]);
    const backward = encodeLinkTargetSet([...urls].reverse());
    expect(forward).toEqual(backward);
    expect(forward.count).toBe(25);
  });

  test("an empty list is an empty, complete set", () => {
    expect(encodeLinkTargetSet([])).toEqual({ hashes: "", count: 0, complete: true });
    expect(decodeLinkTargetSet({ hashes: "", count: 0, complete: true })?.size).toBe(0);
  });

  test("past the cap, or from a partial list, a set is not complete", () => {
    const many = Array.from({ length: LINK_TARGET_SET_MAX_HASHES + 5 }, (_, i) => `https://e.com/${i}`);
    const capped = encodeLinkTargetSet(many);
    expect(capped).toMatchObject({ count: LINK_TARGET_SET_MAX_HASHES + 5, complete: false });
    expect(decodeLinkTargetSet(capped)?.size).toBe(LINK_TARGET_SET_MAX_HASHES);
    expect(encodeLinkTargetSet(urls, { partial: true }).complete).toBe(false);
    expect(encodeLinkTargetSet(urls, { maxHashes: 10 }).complete).toBe(false);
  });

  test("a value that is not a well-formed set decodes to null", () => {
    for (const bad of [null, "x", {}, { hashes: 3 }, { hashes: "not base64!" }, { hashes: "AAAA" }]) {
      expect(decodeLinkTargetSet(bad)).toBeNull();
    }
  });
});
