// schema/coverage-outlier — structured-data outliers vs the site's own norm (#1363).
//
// The rule's whole value is what it does NOT say, so most of this file defends the
// silence cases: a small crawl, a page type with too few samples, a site with no
// schema at all (that is the per-type schema rules' finding, not an outlier), a
// group whose members genuinely disagree, and template-uniform pages. The positive
// cases pin the one thing it is for: a handful of pages breaking a pattern the
// rest of their OWN page type keeps.
//
// Every fixture runs through `bothPaths`, so the legacy `ctx.site.pages` path and
// the streaming `SiteQuery` path are asserted byte-identical on all of them.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { getRichResultTypes } from "@squirrelscan/utils";

import {
  schemaCoverageOutlierRule,
  SCHEMA_NORM_MIN_GROUP_PAGES,
  SCHEMA_NORM_MIN_PAGES,
} from "../src/schema/coverage-outlier";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  pageType: string | null;
  schemaTypes: string[];
  status?: number;
}

function url(i: number): string {
  return `https://example.com/p${String(i).padStart(3, "0")}`;
}

/** N pages of one type, all carrying the same schema @types. */
function uniform(pageType: string, schemaTypes: string[], count: number): PageSpec[] {
  return Array.from({ length: count }, () => ({ pageType, schemaTypes }));
}

const baseCtx = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

/** Legacy path: specs become `ctx.site.pages` in crawl (url ascending) order. */
function legacyCtx(specs: PageSpec[]): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: "https://example.com/",
      pages: specs.map((spec, i) => ({
        url: url(i),
        statusCode: spec.status ?? 200,
        parsed: {
          pageType: spec.pageType,
          schemas: { types: spec.schemaTypes },
        } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function featureRow(spec: PageSpec, i: number): PageFeatureRow {
  return {
    normalizedUrl: url(i),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: spec.pageType,
    schemaTypes: spec.schemaTypes,
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    // Exactly what page-features stores, so the two paths see one value.
    richResultTypes: getRichResultTypes({ types: spec.schemaTypes } as never),
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
    faviconHref: null,
    themeColor: null,
    ogImage: null,
  };
}

/**
 * Streaming path: the rule only ever calls `pagesMatching` + `pageCount`, so the
 * rest of the SiteQuery surface throws — a stub that silently returned empties
 * could hide the rule reading something it must not.
 */
function siteQueryCtx(specs: PageSpec[]): RuleContext {
  const rows = specs.map(featureRow);
  const unused = (): never => {
    throw new Error("coverage-outlier must not use this SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (row: PageFeatureRow) => boolean) {
      for (const row of rows) if (pred(row)) yield row;
    },
  };
  return {
    ...baseCtx,
    // EMPTY pages — the streaming path must not read them.
    site: { baseUrl: "https://example.com/", pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
  };
}

async function checks(ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(schemaCoverageOutlierRule.run(ctx))).checks;
}

/** Run BOTH paths over one fixture, assert byte-identical output, return it. */
async function bothPaths(specs: PageSpec[]): Promise<CheckResult> {
  const legacy = await checks(legacyCtx(specs));
  const streamed = await checks(siteQueryCtx(specs));
  expect(streamed).toEqual(legacy);
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

/** A group of `total` pages of `pageType` where only `have` carry `schemaTypes`. */
function partial(
  pageType: string,
  schemaTypes: string[],
  have: number,
  total: number
): PageSpec[] {
  return Array.from({ length: total }, (_, i) => ({
    pageType,
    schemaTypes: i < have ? schemaTypes : [],
  }));
}

describe("schema/coverage-outlier — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(uniform("product", ["Product"], SCHEMA_NORM_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${SCHEMA_NORM_MIN_PAGES} needed`);
  });

  test("skips when no page type has enough comparable pages", async () => {
    // 12 pages, but spread thin: every type is under the group floor.
    const specs = [
      ...uniform("product", ["Product"], 4),
      ...uniform("article", ["Article"], 4),
      ...uniform("about", ["Organization"], 4),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${SCHEMA_NORM_MIN_GROUP_PAGES}+ comparable pages`);
  });

  test("a site with no schema anywhere stays clean — that is the per-type rules' finding", async () => {
    const specs = [...uniform("product", [], 12), ...uniform("article", [], 12)];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("sharing a structured-data pattern");
  });

  test("skips a group with no modal agreement — every page marks itself up differently", async () => {
    // 10 product pages, each with its own @type: no type reaches 70%.
    const specs = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((t) => ({
      pageType: "product",
      schemaTypes: [t],
    }));
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
  });

  test("a type just under the agreement threshold forms no norm", async () => {
    // 6 of 10 = 60% < 70%: the majority is not enough to call the other 4 wrong.
    const check = await bothPaths(partial("product", ["Product"], 6, 10));
    expect(check.status).toBe("skipped");
  });

  test("untyped pages never form a group", async () => {
    const specs = [
      ...uniform("product", ["Product"], 10),
      ...uniform("unknown", [], 4),
      ...Array.from({ length: 4 }, () => ({ pageType: null, schemaTypes: [] })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(10);
  });

  test("non-2xx pages are excluded from the norm and never flagged", async () => {
    const specs = [
      ...uniform("product", ["Product"], 10),
      ...Array.from({ length: 3 }, () => ({ pageType: "product", schemaTypes: [], status: 404 })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(10);
  });
});

describe("schema/coverage-outlier — template-uniform pages sit inside the norm", () => {
  test("passes when every page of a type carries the same markup", async () => {
    const specs = [
      ...uniform("product", ["Product", "BreadcrumbList"], 20),
      ...uniform("article", ["Article"], 10),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.items).toBeUndefined();
    expect(check.details?.judgedPages).toBe(30);
    expect(check.message).toContain("article Article");
  });

  test("@type casing drift does not split the norm", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({
      pageType: "product",
      schemaTypes: [i % 2 === 0 ? "Product" : "product"],
    }));
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("an optional extra on a minority of pages is not a norm, and does not hide a real gap", async () => {
    // 40/45 carry Product; a BreadcrumbList on 10 of them never reaches 70%.
    const specs = partial("product", ["Product"], 40, 45).map((spec, i) =>
      i < 10 ? { ...spec, schemaTypes: [...spec.schemaTypes, "BreadcrumbList"] } : spec
    );
    const check = await bothPaths(specs);
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.meta?.schemaType).toBe("Product");
  });
});

describe("schema/coverage-outlier — outliers", () => {
  test("warns and names the ratio it is arguing from", async () => {
    const check = await bothPaths(partial("product", ["Product"], 40, 45));
    expect(check.status).toBe("warn");
    expect(check.value).toBe(5);
    expect(check.message).toContain("5 of 45 page(s) are missing structured data");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.label).toBe(
      "40 of 45 product pages have Product schema, these 5 do not"
    );
    expect(check.items?.[0]?.sourcePages).toHaveLength(5);
    expect(check.items?.[0]?.meta).toEqual({
      pageType: "product",
      schemaType: "Product",
      richResult: true,
      have: 40,
      total: 45,
      missing: 5,
    });
  });

  test("fails once the deviant share crosses the fail threshold", async () => {
    // 7 of 10 carry Product (exactly the agreement floor) → 3/10 = 30% deviant.
    const check = await bothPaths(partial("product", ["Product"], 7, 10));
    expect(check.status).toBe("fail");
    expect(check.value).toBe(3);
  });

  test("only the deviating page type is flagged; healthy groups stay quiet", async () => {
    const specs = [
      ...partial("product", ["Product"], 40, 45),
      ...uniform("article", ["Article"], 20),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.details?.judgedPages).toBe(65);
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.meta?.pageType).toBe("product");
  });

  test("a page missing two norm types counts once toward the deviant share", async () => {
    const specs = partial("product", ["Product", "BreadcrumbList"], 40, 45);
    const check = await bothPaths(specs);
    // Two gaps reported, but 5 deviant pages, not 10.
    expect(check.items).toHaveLength(2);
    expect(check.value).toBe(5);
    expect(check.details?.flaggedPages).toBe(5);
  });

  test("a non-rich-result @type is still reported, flagged as such", async () => {
    const check = await bothPaths(partial("about", ["WebPage"], 10, 12));
    expect(check.items?.[0]?.meta?.richResult).toBe(false);
  });
});

describe("schema/coverage-outlier — legacy-path edge cases", () => {
  test("an empty site skips rather than throwing", async () => {
    const result = await checks(legacyCtx([]));
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("skipped");
    expect(result[0]?.message).toBe("No pages available for analysis");
  });
});
