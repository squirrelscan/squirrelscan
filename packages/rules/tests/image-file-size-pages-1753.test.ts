// images/image-file-size names the pages that embed an oversized file, and
// perf/total-byte-weight names the heaviest resource on the heaviest page (#1753).

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { imageFileSizeRule } from "../src/images/image-file-size";
import { totalByteWeightRule } from "../src/performance/total-byte-weight";
import type { CheckResult, RuleContext } from "../src/types";

const BASE = "https://example.com";
const KB = 1024;
const MB = 1024 * KB;

const entry = (path: string, size: number, pages: string[]) => ({
  url: `${BASE}${path}`,
  status: 200,
  error: null,
  contentType: "image/svg+xml",
  sizeBytes: size,
  sourcePages: pages.map((p) => `${BASE}${p}`),
});

function siteCtx(site: object, options: object = {}): RuleContext {
  return {
    page: { url: BASE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    options,
    site: { baseUrl: BASE, pages: [], ...site },
  } as unknown as RuleContext;
}

function fileSize(images: ReturnType<typeof entry>[]): CheckResult[] {
  const result = imageFileSizeRule.run(siteCtx({ resourceSizes: { css: [], images, fonts: [] } }));
  if (result instanceof Promise) throw new Error("async");
  return result.checks;
}

describe("images/image-file-size item pages (#1753)", () => {
  test("the item carries its pages in sourcePages, meta and the label", () => {
    const [check] = fileSize([entry("/_fault/big.svg", 2.5 * MB, ["/", "/about"])]);
    expect(check!.status).toBe("fail");
    const item = check!.items![0]!;
    expect(item.id).toBe(`${BASE}/_fault/big.svg`);
    expect(item.sourcePages).toEqual([`${BASE}/`, `${BASE}/about`]);
    expect(item.meta).toMatchObject({
      pageCount: 2,
      pages: [`${BASE}/`, `${BASE}/about`],
      size: "2.5 MB",
    });
    expect(item.label).toBe(`${BASE}/_fault/big.svg (2.5 MB, embedded on 2 pages)`);
  });

  test("a warn-size file gets the same page list", () => {
    const checks = fileSize([entry("/mid.jpg", 600 * KB, ["/"])]);
    const warn = checks.find((c) => c.name === "image-file-size-warn")!;
    expect(warn.items![0]!.meta?.pages).toEqual([`${BASE}/`]);
    expect(warn.items![0]!.label).toBe(`${BASE}/mid.jpg (600.0 KB, embedded on 1 page)`);
  });

  test("meta lists at most 10 pages and counts the rest", () => {
    const pages = Array.from({ length: 14 }, (_, i) => `/p${i}`);
    const item = fileSize([entry("/big.svg", 2 * MB, pages)])[0]!.items![0]!;
    expect((item.meta?.pages as string[]).length).toBe(10);
    expect(item.meta?.pageCount).toBe(14);
    expect(item.meta?.pagesNotListed).toBe(4);
    expect(item.sourcePages).toHaveLength(14);
  });

  test("a file with no recorded page says so and invents none", () => {
    const item = fileSize([entry("/big.svg", 2 * MB, [])])[0]!.items![0]!;
    expect(item.sourcePages).toEqual([]);
    expect(item.meta?.pages).toBeUndefined();
    expect(item.meta?.pageCount).toBe(0);
    expect(item.label).toBe(`${BASE}/big.svg (2.0 MB, no crawled page recorded as embedding it)`);
  });
});

describe("perf/total-byte-weight heaviest resource (#1753)", () => {
  const pageUrl = `${BASE}/`;
  const doc = `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>`;
  const res = (path: string, size: number | null, page = pageUrl) => ({
    url: `${BASE}${path}`,
    status: 200,
    error: null,
    contentType: null,
    sizeBytes: size,
    sourcePages: [page],
  });

  function weigh(site: object): CheckResult {
    const ctx = siteCtx({
      pages: [
        { url: pageUrl, statusCode: 200, parsed: parsePage(doc, pageUrl), sizeBytes: 5 * KB },
        {
          url: `${BASE}/other`,
          statusCode: 200,
          parsed: parsePage(doc, `${BASE}/other`),
          sizeBytes: 5 * KB,
        },
      ],
      ...site,
    });
    return totalByteWeightRule.run(ctx).checks[0]!;
  }

  test("names the largest resource of the heaviest page with its size and kind", () => {
    const check = weigh({
      resourceSizes: {
        css: [res("/a.css", 20 * KB)],
        images: [res("/_fault/big-image.svg", 2500 * KB), res("/logo.png", 30 * KB)],
        fonts: [],
      },
      scripts: [{ ...res("/app.js", 200 * KB), content: null }],
    });
    expect(check.message).toContain(
      `Heaviest page: ${BASE}/ 2755KB, largest resource ${BASE}/_fault/big-image.svg 2500KB (`,
    );
    expect(check.details).toMatchObject({
      heaviestPage: pageUrl,
      heaviestResource: `${BASE}/_fault/big-image.svg`,
      heaviestResourceKb: "2500KB",
      heaviestResourceKind: "images",
    });
  });

  test("only resources on the heaviest page are considered", () => {
    const check = weigh({
      resourceSizes: {
        css: [],
        images: [
          res("/huge-elsewhere.png", 900 * KB, `${BASE}/other`),
          res("/bigger.png", 1000 * KB),
        ],
        fonts: [],
      },
    });
    expect(check.details?.heaviestPage).toBe(pageUrl);
    expect(check.details?.heaviestResource).toBe(`${BASE}/bigger.png`);
  });

  test("a page with no sized resources names none", () => {
    const check = weigh({ resourceSizes: { css: [], images: [res("/x.png", null)], fonts: [] } });
    expect(check.details?.heaviestResource).toBeUndefined();
    expect(check.message).not.toContain("largest resource");
  });
});
