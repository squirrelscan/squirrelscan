// content/thin-vs-site-norm — word-count outliers vs the site's own norm (#1362).
//
// The rule's whole value is what it does NOT say, so most of this file defends the
// silence cases: a small crawl, a page type with too few samples, a heterogeneous
// group, a site that is uniformly short, and a page already owned by
// content/word-count. The positive cases pin the one thing it is for: a page far
// below its OWN page type's median, on a site where that type has a clear norm.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  thinVsSiteNormRule,
  THIN_NORM_MIN_GROUP_PAGES,
  THIN_NORM_MIN_PAGES,
} from "../src/content/thin-vs-site-norm";
import { WORD_COUNT_MIN_WORDS } from "../src/content/word-count";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  pageType: string | null;
  wordCount: number | null;
  status?: number;
}

function url(i: number): string {
  return `https://example.com/p${String(i).padStart(3, "0")}`;
}

/** N pages of one type, all at the same word count. */
function uniform(pageType: string, wordCount: number, count: number): PageSpec[] {
  return Array.from({ length: count }, () => ({ pageType, wordCount }));
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
          content: { wordCount: spec.wordCount },
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
    wordCount: spec.wordCount,
    pageType: spec.pageType,
    schemaTypes: [],
    robotsNoindex: false,
    canonical: null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: [],
    richResultTypes: [],
    napName: null,
    napPhones: [],
    napPhoneFormats: [],
    napAddress: null,
    napAddressFormat: null,
    napTelLink: false,
    napMailtoLink: false,
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
    throw new Error("thin-vs-site-norm must not use this SiteQuery method");
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
  return (await Promise.resolve(thinVsSiteNormRule.run(ctx))).checks;
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

describe("content/thin-vs-site-norm — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(uniform("article", 1800, THIN_NORM_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${THIN_NORM_MIN_PAGES} needed`);
  });

  test("skips when no page type has enough comparable pages", async () => {
    // 12 pages, but spread thin: every type is under the group floor.
    const specs = [
      ...uniform("article", 1800, 4),
      ...uniform("product", 200, 4),
      ...uniform("about", 400, 4),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${THIN_NORM_MIN_GROUP_PAGES}+ comparable pages`);
  });

  test("skips a heterogeneous group — no modal norm to deviate from", async () => {
    // Word counts scattered across an order of magnitude: fewer than 70% of the
    // group sits within ±50% of the median, so the median is not a norm.
    const scattered = [300, 400, 900, 1500, 2600, 4000, 6000, 9000, 12000, 16000];
    const specs = scattered.map((wordCount) => ({ pageType: "article", wordCount }));
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
  });

  test("untyped pages never form a group", async () => {
    const specs = [
      ...uniform("article", 1800, 10),
      ...Array.from({ length: 4 }, () => ({ pageType: "unknown", wordCount: 40 })),
      ...Array.from({ length: 4 }, () => ({ pageType: null, wordCount: 40 })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(10);
  });

  test("non-2xx pages are excluded from the distribution", async () => {
    const specs = [
      ...uniform("article", 1800, 10),
      ...Array.from({ length: 5 }, () => ({ pageType: "article", wordCount: 12, status: 404 })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(10);
  });
});

describe("content/thin-vs-site-norm — the no-false-positive fixtures", () => {
  test("a site of uniformly short pages stays clean because the norm is short", async () => {
    // Every page is 120 words. An absolute rule screams; the norm IS 120.
    const check = await bothPaths(uniform("product", 120, 20));
    expect(check.status).toBe("pass");
  });

  test("template-uniform siblings sit inside the norm", async () => {
    // Same template, small natural jitter — nothing here is an outlier.
    const jitter = [980, 1000, 1010, 1020, 995, 1005, 1030, 970, 1000, 1015, 990, 1008];
    const check = await bothPaths(jitter.map((wordCount) => ({ pageType: "product", wordCount })));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("within their page type's word-count norm");
  });

  test("a short page type is judged against itself, not against the long one", async () => {
    // 200-word products are the product norm; 200-word articles are not the
    // article norm. Only the article is flagged.
    const specs = [
      ...uniform("product", 200, 10),
      ...uniform("article", 1800, 10),
      { pageType: "article", wordCount: 320 },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.meta?.pageType).toBe("article");
    expect(check.items?.[0]?.meta?.wordCount).toBe(320);
  });

  test("defers to content/word-count below its absolute floor", async () => {
    // 200 words in an 1800-word article group IS an outlier by distribution, but
    // content/word-count already owns every page under its min_words, so this
    // rule stays silent about it and the two never both flag one page.
    const specs = [
      ...uniform("article", 1800, 10),
      { pageType: "article", wordCount: WORD_COUNT_MIN_WORDS - 1 },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });
});

describe("content/thin-vs-site-norm — findings", () => {
  test("warns on a sparse handful of outliers", async () => {
    const specs = [
      ...uniform("article", 1800, 20),
      { pageType: "article", wordCount: 400 },
      { pageType: "article", wordCount: 350 },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.value).toBe(2);
    expect(check.items).toHaveLength(2);
    // Worst offender first.
    expect(check.items?.[0]?.meta?.wordCount).toBe(350);
    expect(check.details?.flaggedPages).toBe(2);
  });

  test("fails once a fifth of the judged pages are outliers", async () => {
    const specs = [
      ...uniform("article", 1800, 10),
      ...uniform("article", 400, 4),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.value).toBe(4);
  });

  test("caps the reported items", async () => {
    const specs = [
      ...uniform("article", 1800, 40),
      ...uniform("article", 400, 12),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.items?.length).toBe(10);
    expect(check.details?.flaggedPages).toBe(12);
  });

  test("dual paths agree on a mixed fixture regardless of crawl-order ties", async () => {
    const specs = [
      ...uniform("article", 1500, 12),
      ...uniform("product", 240, 12),
      { pageType: "article", wordCount: 380 },
      { pageType: "product", wordCount: 310 },
    ];
    const check = await bothPaths(specs);
    // The 310-word product is ABOVE its own type's 240 norm: only the article fires.
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.meta?.pageType).toBe("article");
  });
});

describe("content/thin-vs-site-norm — empty crawl", () => {
  test("legacy path with no pages skips", async () => {
    const result = await checks(legacyCtx([]));
    expect(result[0]?.status).toBe("skipped");
  });
});
