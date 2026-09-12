// #2063 — the page identity used by the finding store keeps the query string.
//
// `normalizeUrl` drops it, which is right for "is this the same resource"
// comparisons and wrong for "which page is this": a catalogue of 384
// `?id=N` pages collapsed into one stored URL carrying 362 copies of the same
// rule's finding.

import { describe, expect, test } from "bun:test";

import { normalizePageUrl, normalizeUrl, stripUrlQuery } from "../src/url";

describe("normalizePageUrl", () => {
  test("keeps the query string, which normalizeUrl drops", () => {
    const a = "https://x.test/p?id=1";
    const b = "https://x.test/p?id=2";

    expect(normalizePageUrl(a)).toBe(a);
    expect(normalizePageUrl(b)).toBe(b);
    expect(normalizePageUrl(a)).not.toBe(normalizePageUrl(b));

    // The old identity — one page where there are two.
    expect(normalizeUrl(a)).toBe(normalizeUrl(b));
  });

  test("keeps parameter order verbatim (the crawler's frontier entries differ)", () => {
    expect(normalizePageUrl("https://x.test/p?a=1&b=2")).toBe("https://x.test/p?a=1&b=2");
    expect(normalizePageUrl("https://x.test/p?b=2&a=1")).toBe("https://x.test/p?b=2&a=1");
  });

  test("otherwise matches normalizeUrl: lowercased scheme/host, kept path case, no trailing slash, no fragment", () => {
    expect(normalizePageUrl("HTTPS://X.TEST/About/")).toBe("https://x.test/About");
    expect(normalizePageUrl("https://x.test/p#section")).toBe("https://x.test/p");
    expect(normalizePageUrl("https://x.test/")).toBe("https://x.test/");
    expect(normalizePageUrl("https://x.test/p?id=1#frag")).toBe("https://x.test/p?id=1");
  });

  test("returns unparseable input unchanged", () => {
    expect(normalizePageUrl("not a url")).toBe("not a url");
  });
});

describe("stripUrlQuery", () => {
  test("recovers the pre-#2063 spelling of a page identity", () => {
    expect(stripUrlQuery("https://x.test/p?id=1")).toBe("https://x.test/p");
    expect(stripUrlQuery(normalizePageUrl("https://x.test/p?id=1"))).toBe(
      normalizeUrl("https://x.test/p?id=1"),
    );
  });

  test("leaves a query-less URL alone", () => {
    expect(stripUrlQuery("https://x.test/p")).toBe("https://x.test/p");
  });
});
