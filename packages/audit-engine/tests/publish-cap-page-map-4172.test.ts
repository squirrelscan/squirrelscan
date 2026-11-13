// repo#4172: the page map rides the same capped publish body as the entity map. It is
// re-projected to its bound, stamped when it cannot be, and dropped (stamped) before any issue
// class is reduced.

import { describe, expect, test } from "bun:test";

import type { PageMap } from "@squirrelscan/core-contracts/page-map";
import { buildPageMap } from "@squirrelscan/report/page-map-publish";

import { capReportForPublish, type CappableReport } from "../src/publish-cap";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.test/p/${i}`,
    finalUrl: `https://example.test/p/${i}`,
    status: i % 10 === 0 ? 404 : 200,
    depth: i % 3,
    canonical: null,
    noindex: false,
    title: `Page ${i}`,
    titleLength: 6,
    description: null,
    descriptionLength: 0,
    h1Count: 1,
    h1: null,
    headingCount: null,
    wordCount: 100,
    schemaTypes: [],
    schemaIds: [],
    inlinks: 0,
    internalOutlinks: 0,
    externalOutlinks: 0,
    externalDomains: [],
    loadTimeMs: null,
    lastModified: null,
    flags: ["orphan"],
  }));

const base = (pageMap: PageMap | null | undefined): CappableReport => ({
  ruleResults: {},
  pages: [],
  ...(pageMap === undefined ? {} : { pageMap }),
});

describe("capReportForPublish pageMap", () => {
  test("a built page map is published with its counts", () => {
    const map = buildPageMap(rows(1500), { site: "https://example.test" })!;
    const out = capReportForPublish(base(map));
    expect(out.pageMap?.stored).toBe(1000);
    expect(out.pageMap?.total).toBe(1500);
    expect(out.pageMap?.truncated).toBe(true);
    expect(out.detail.pageMapDropped).toBeUndefined();
    expect(out.detail.pageMapFailed).toBeUndefined();
  });

  test("a report without one publishes without one", () => {
    const out = capReportForPublish(base(undefined));
    expect(out.pageMap).toBeUndefined();
  });

  test("an unprojectable map is left out and stamped", () => {
    const out = capReportForPublish(base({ format: "broken", pages: null } as unknown as PageMap));
    expect(out.pageMap).toBeUndefined();
    expect(out.detail.pageMapFailed).toBe(true);
  });

  test("a producer cannot raise the cap by sending more rows", () => {
    const map = buildPageMap(rows(10), { site: "https://example.test" })!;
    const stuffed = { ...map, pages: rows(2000) } as unknown as PageMap;
    const out = capReportForPublish(base(stuffed));
    expect(out.pageMap?.pages).toHaveLength(1000);
    expect(out.pageMap?.truncated).toBe(true);
  });
});
