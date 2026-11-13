// repo#4172: the published page map. Rows are bounded, ordered, counted, and valid against the
// core-contracts schema the API validates with.

import { describe, expect, test } from "bun:test";

import { PAGE_MAP_PUBLISH_LIMITS, PageMapSchema } from "@squirrelscan/core-contracts/page-map";
import { Value } from "@sinclair/typebox/value";

import type { PageMapRow } from "@squirrelscan/report/page-map";
import { buildPageMap, projectPageMap } from "@squirrelscan/report/page-map-publish";

function row(i: number, over: Partial<PageMapRow> = {}): PageMapRow {
  return {
    url: `https://example.test/p/${String(i).padStart(5, "0")}`,
    finalUrl: `https://example.test/p/${String(i).padStart(5, "0")}`,
    status: 200,
    depth: i % 4,
    canonical: null,
    noindex: false,
    title: `Page ${i}`,
    titleLength: 6,
    description: null,
    descriptionLength: 0,
    h1Count: 1,
    h1: `Page ${i}`,
    headingCount: 3,
    wordCount: 300,
    schemaTypes: ["Article"],
    schemaIds: [],
    inlinks: 1,
    internalOutlinks: 4,
    externalOutlinks: 0,
    externalDomains: [],
    loadTimeMs: 120,
    lastModified: null,
    flags: [],
    ...over,
  };
}

describe("buildPageMap", () => {
  test("a small audit is stored whole and validates", () => {
    const map = buildPageMap([row(1), row(2)], { site: "https://example.test" })!;
    expect(map.total).toBe(2);
    expect(map.stored).toBe(2);
    expect(map.truncated).toBe(false);
    expect(Value.Check(PageMapSchema, map)).toBe(true);
  });

  test("an audit over the cap keeps maxRows, shallowest first, and says so", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(i));
    const map = buildPageMap(rows, { site: "https://example.test" })!;
    expect(map.pages).toHaveLength(PAGE_MAP_PUBLISH_LIMITS.maxRows);
    expect(map.stored).toBe(1000);
    expect(map.total).toBe(1500);
    expect(map.truncated).toBe(true);
    expect(map.pages[0]!.depth).toBe(0);
    expect(Value.Check(PageMapSchema, map)).toBe(true);
  });

  test("failed pages stay, with their status", () => {
    const map = buildPageMap(
      [row(1, { status: 404, title: null, wordCount: null, h1Count: null, h1: null })],
      { site: "https://example.test" },
    )!;
    expect(map.pages[0]!.status).toBe(404);
    expect(Value.Check(PageMapSchema, map)).toBe(true);
  });

  test("site-controlled strings and lists are clipped to the publish bound", () => {
    const long = "x".repeat(5000);
    const map = buildPageMap(
      [row(1, { title: long, externalDomains: Array.from({ length: 80 }, (_, i) => `h${i}.test`) })],
      { site: "https://example.test" },
    )!;
    expect(map.pages[0]!.title!.length).toBeLessThanOrEqual(PAGE_MAP_PUBLISH_LIMITS.maxStringLength);
    expect(map.pages[0]!.externalDomains).toHaveLength(PAGE_MAP_PUBLISH_LIMITS.maxListItems);
    expect(Value.Check(PageMapSchema, map)).toBe(true);
  });

  test("a clip never splits a surrogate pair", () => {
    const max = PAGE_MAP_PUBLISH_LIMITS.maxStringLength;
    const title = `${"a".repeat(max - 1)}😀`;
    const out = buildPageMap([row(1, { title })], { site: "https://example.test" })!.pages[0]!.title!;
    expect(out).toBe("a".repeat(max - 1));
  });

  test("no pages, no map", () => {
    expect(buildPageMap([], { site: "https://example.test" })).toBeNull();
  });
});

describe("projectPageMap", () => {
  test("recounts and never trusts the producer's counts", () => {
    const map = buildPageMap([row(1), row(2)], { site: "https://example.test" })!;
    const forged = { ...map, total: 1, stored: 99, truncated: false };
    const out = projectPageMap(forged);
    expect(out.stored).toBe(2);
    expect(out.total).toBe(2);
    expect(out.truncated).toBe(false);
  });

  test("rows past the cap are cut and the map is marked truncated", () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i));
    const big = buildPageMap(rows, { site: "https://example.test" })!;
    const out = projectPageMap({ ...big, pages: rows.map((r) => ({ ...r })) as never, total: 1200 });
    expect(out.stored).toBe(1000);
    expect(out.truncated).toBe(true);
  });
});
