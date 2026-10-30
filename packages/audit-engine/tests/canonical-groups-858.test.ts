// #858: query-string variants that declare another crawled page of the same path as
// their canonical are counted with it; everything else stays a page of its own.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { canonicalVariantMap, foldChecksToCanonical } from "../src/canonical-groups";

const S = "https://example.com";

describe("canonicalVariantMap", () => {
  test("a variant whose canonical is another crawled page of the same path folds into it", () => {
    const map = canonicalVariantMap([
      { url: `${S}/contact`, canonical: `${S}/contact` },
      { url: `${S}/contact?subject=Billing`, canonical: `${S}/contact` },
      { url: `${S}/about`, canonical: null },
    ]);
    expect([...map]).toEqual([[`${S}/contact?subject=Billing`, `${S}/contact`]]);
  });

  test("relative canonicals, trailing slashes and fragments resolve; a self canonical does not fold", () => {
    const map = canonicalVariantMap([
      { url: `${S}/contact/`, canonical: null },
      { url: `${S}/contact/?a=1`, canonical: "/contact#top" },
      { url: `${S}/contact/?b=2`, canonical: `${S}/contact/?b=2` },
    ]);
    expect([...map]).toEqual([[`${S}/contact/?a=1`, `${S}/contact/`]]);
  });

  test("search, pagination and filter pages with their own canonical, another path, another host or an uncrawled canonical stay separate", () => {
    const map = canonicalVariantMap([
      { url: `${S}/blog`, canonical: `${S}/blog` },
      { url: `${S}/blog?page=2`, canonical: `${S}/blog?page=2` },
      { url: `${S}/shop?color=red`, canonical: `${S}/shop` }, // /shop is not crawled
      { url: `${S}/a?x=1`, canonical: `${S}/b` }, // different path
      { url: `${S}/a`, canonical: `${S}/a` },
      { url: `${S}/b`, canonical: `${S}/b` },
      { url: `${S}/c?x=1`, canonical: "https://other.com/c" },
      { url: `${S}/c`, canonical: null },
    ]);
    expect(map.size).toBe(0);
  });

  test("chains resolve to the last page and loops are dropped", () => {
    const map = canonicalVariantMap([
      { url: `${S}/p`, canonical: null },
      { url: `${S}/p?a=1`, canonical: `${S}/p?b=2` },
      { url: `${S}/p?b=2`, canonical: `${S}/p` },
      { url: `${S}/q?a=1`, canonical: `${S}/q?b=1` },
      { url: `${S}/q?b=1`, canonical: `${S}/q?a=1` },
    ]);
    expect(map.get(`${S}/p?a=1`)).toBe(`${S}/p`);
    expect(map.get(`${S}/p?b=2`)).toBe(`${S}/p`);
    expect(map.has(`${S}/q?a=1`)).toBe(false);
  });
});

describe("foldChecksToCanonical", () => {
  const map = new Map([[`${S}/contact?subject=Billing`, `${S}/contact`]]);
  const check = (extra: Partial<CheckResult>): CheckResult => ({ name: "c", status: "fail", message: "m", ...extra });

  test("a page and its variant failing the same check are one affected page, in pageUrl, pages and item pages", () => {
    const checks = [
      check({ pageUrl: `${S}/contact` }),
      check({ pageUrl: `${S}/contact?subject=Billing` }),
      check({ pages: [`${S}/contact`, `${S}/contact?subject=Billing`, `${S}/about`] }),
      check({ items: [{ id: "x", sourcePages: [`${S}/contact?subject=Billing`, `${S}/contact`] }, { id: `${S}/contact?subject=Billing` }] }),
    ];
    expect(foldChecksToCanonical(checks, map)).toBe(3);
    expect(checks[1]!.pageUrl).toBe(`${S}/contact`);
    expect(checks[2]!.pages).toEqual([`${S}/contact`, `${S}/about`]);
    expect(checks[3]!.items![0]!.sourcePages).toEqual([`${S}/contact`]);
    expect(checks[3]!.items![1]!.id).toBe(`${S}/contact`);
    // idempotent
    expect(foldChecksToCanonical(checks, map)).toBe(0);
  });

  test("items that were two pages become one: listed once, with the counts following the list", () => {
    const c = check({
      items: [{ id: `${S}/contact` }, { id: `${S}/contact?subject=Billing` }, { id: `${S}/about` }],
      details: { count: 3, occurrences: 3, keep: "x" },
    });
    foldChecksToCanonical([c], map);
    expect(c.items!.map((i) => i.id)).toEqual([`${S}/contact`, `${S}/about`]);
    expect(c.details).toMatchObject({ count: 2, occurrences: 2, keep: "x" });
    // a count that did not equal the list is left alone
    const d = check({ items: [{ id: `${S}/contact` }, { id: `${S}/contact?subject=Billing` }], details: { count: 9 } });
    foldChecksToCanonical([d], map);
    expect(d.details).toMatchObject({ count: 9 });
  });

  test("nothing changes without variants", () => {
    const c = check({ pageUrl: `${S}/a` });
    expect(foldChecksToCanonical([c], new Map())).toBe(0);
    expect(c.pageUrl).toBe(`${S}/a`);
  });
});

describe("canonicalVariantMap at scale", () => {
  test("a 10,000-page chain resolves in linear time, to the last page", () => {
    const pages = Array.from({ length: 10_000 }, (_, i) => ({ url: `${S}/p?n=${i}`, canonical: i === 9_999 ? null : `${S}/p?n=${i + 1}` }));
    const started = performance.now();
    const map = canonicalVariantMap(pages);
    expect(performance.now() - started).toBeLessThan(500);
    expect(map.size).toBe(9_999);
    expect(map.get(`${S}/p?n=0`)).toBe(`${S}/p?n=9999`);
    expect(map.get(`${S}/p?n=5000`)).toBe(`${S}/p?n=9999`);
  });

  test("a flat page set is linear too, and a long loop folds nothing", () => {
    const flat = [{ url: `${S}/p`, canonical: null }, ...Array.from({ length: 10_000 }, (_, i) => ({ url: `${S}/p?n=${i}`, canonical: `${S}/p` }))];
    const started = performance.now();
    expect(canonicalVariantMap(flat).size).toBe(10_000);
    const loop = Array.from({ length: 10_000 }, (_, i) => ({ url: `${S}/q?n=${i}`, canonical: `${S}/q?n=${(i + 1) % 10_000}` }));
    expect(canonicalVariantMap(loop).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
