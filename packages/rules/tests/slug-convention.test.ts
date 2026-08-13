// url/slug-convention — URL conventions vs the site's own norm (#1365).
//
// The rule's whole value is what it does NOT say, so most of this file defends the
// silence cases: a small crawl, a dimension with too few voters, a site that mixes
// deliberately, a site that is uniformly non-default (all snake_case), and the
// deviants the per-page url rules already own. The positive cases pin the one thing
// it is for: a minority form standing against a clear dominant one.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  slugConventionRule,
  SLUG_NORM_MIN_AGREEMENT,
  SLUG_NORM_MIN_PAGES,
} from "../src/url/slug-convention";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  path: string;
  pageType?: string | null;
  status?: number;
}

function url(path: string): string {
  return `https://example.com${path}`;
}

/** N pages sharing one path template, numbered so each url is distinct. */
function template(
  make: (i: number) => string,
  count: number,
  pageType: string | null = "article"
): PageSpec[] {
  return Array.from({ length: count }, (_, i) => ({ path: make(i), pageType }));
}

function pad(i: number): string {
  return String(i).padStart(3, "0");
}

const baseCtx = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as ParsedPage,
  options: {},
};

/** Legacy path: specs become `ctx.site.pages` in crawl order. */
function legacyCtx(specs: PageSpec[]): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: "https://example.com/",
      pages: specs.map((spec) => ({
        url: url(spec.path),
        statusCode: spec.status ?? 200,
        parsed: { pageType: spec.pageType ?? null } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function featureRow(spec: PageSpec): PageFeatureRow {
  return {
    normalizedUrl: url(spec.path),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: spec.pageType ?? null,
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
    throw new Error("slug-convention must not use this SiteQuery method");
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
  return (await Promise.resolve(slugConventionRule.run(ctx))).checks;
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

/** The one item for a dimension, or undefined when it was not reported. */
function itemFor(check: CheckResult, dimension: string): unknown {
  return check.items?.find((i) => i.meta?.dimension === dimension);
}

describe("url/slug-convention — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(
      template((i) => `/blog/post-${pad(i)}`, SLUG_NORM_MIN_PAGES - 1)
    );
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${SLUG_NORM_MIN_PAGES} needed`);
  });

  test("skips a site that mixes deliberately — no dominant convention", async () => {
    // Half slash-terminated, half bare, and separators split evenly: nothing here
    // reaches the agreement threshold, so no page is a deviant.
    const specs: PageSpec[] = [];
    for (let i = 0; i < 6; i++) {
      specs.push({ path: `/a/post-${pad(i)}/`, pageType: null });
      specs.push({ path: `/b/postThing${pad(i)}`, pageType: null });
    }
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(
      `${Math.round(SLUG_NORM_MIN_AGREEMENT * 100)}% agreement`
    );
  });

  test("a dimension nobody votes in is dropped, not guessed at", async () => {
    // Slugs are single words: the separator dimension gets zero votes and cannot
    // invent one, while the other dimensions are uniform.
    const check = await bothPaths(template((i) => `/p${pad(i)}`, 12));
    expect(check.status).toBe("pass");
    const dims = (check.details?.norms as { dimension: string }[]).map((n) => n.dimension);
    expect(dims).not.toContain("separator");
  });

  test("non-2xx pages never vote", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 12),
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `/blog/post_gone_${pad(i)}`,
        pageType: "article",
        status: 404,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("untyped pages never form a per-type norm", async () => {
    // 12 "unknown" pages at mixed depths: the depth dimension has no group.
    const specs = [
      ...template((i) => `/x/p-${pad(i)}`, 6, "unknown"),
      ...template((i) => `/x/y/z/p-${pad(i)}`, 6, null),
    ];
    const check = await bothPaths(specs);
    const norms = check.details?.norms as { dimension: string; pageType: string | null }[];
    expect(norms.every((n) => n.pageType === null)).toBe(true);
  });
});

describe("url/slug-convention — the no-false-positive fixtures", () => {
  test("a uniformly snake_case site stays clean", async () => {
    // The non-default convention IS this site's convention. url/hyphens will have
    // its say per page; the site is not internally inconsistent, so this rule
    // reports nothing.
    const check = await bothPaths(template((i) => `/blog/post_number_${pad(i)}`, 20));
    expect(check.status).toBe("pass");
    const norms = check.details?.norms as { dimension: string; norm: string }[];
    expect(norms.find((n) => n.dimension === "separator")?.norm).toBe("snake");
  });

  test("a uniformly slash-terminated site stays clean", async () => {
    const check = await bothPaths(template((i) => `/blog/post-${pad(i)}/`, 20));
    expect(check.status).toBe("pass");
    const norms = check.details?.norms as { dimension: string; norm: string }[];
    expect(norms.find((n) => n.dimension === "trailing-slash")?.norm).toBe("slash");
  });

  test("template-uniform siblings sit inside the norm", async () => {
    // Three templates, each internally consistent — the shape of a real generated
    // site. Nothing here is an outlier.
    const specs = [
      ...template((i) => `/deals/offer-${pad(i)}`, 20, "product"),
      ...template((i) => `/stores/store-${pad(i)}`, 20, "listing"),
      ...template((i) => `/blog/article-${pad(i)}`, 20, "article"),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.message).toContain("follow the site's own URL conventions");
  });

  test("page types are judged against themselves, not against each other", async () => {
    // Products live one level deeper than articles. Neither is a deviant: depth is
    // judged within one pageType.
    const specs = [
      ...template((i) => `/shop/cat/item-${pad(i)}`, 12, "product"),
      ...template((i) => `/blog/post-${pad(i)}`, 12, "article"),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });
});

describe("url/slug-convention — findings", () => {
  test("warns on a pocket of camelCase slugs against a kebab-case site", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/legacyPost${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    const item = itemFor(check, "separator") as { meta: Record<string, unknown> } | undefined;
    expect(item?.meta.value).toBe("camel");
    expect(item?.meta.norm).toBe("kebab");
    expect(item?.meta.pageCount).toBe(3);
  });

  test("warns on trailing slashes present on a minority of paths", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/post-slashed-${pad(i)}/`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    const item = itemFor(check, "trailing-slash") as
      | { meta: Record<string, unknown> }
      | undefined;
    expect(item?.meta.value).toBe("slash");
    expect(item?.meta.norm).toBe("bare");
  });

  test("warns on dated slugs for some posts of a type but not others", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/2026/03/post-${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    const item = itemFor(check, "date-in-slug") as
      | { meta: Record<string, unknown> }
      | undefined;
    expect(item?.meta.value).toBe("dated");
    expect(item?.meta.pageType).toBe("article");
  });

  test("warns on inconsistent depth within one page type", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/archive/old/post-${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    const item = itemFor(check, "depth") as { meta: Record<string, unknown> } | undefined;
    expect(item?.meta.value).toBe("4");
    expect(item?.meta.norm).toBe("2");
  });

  test("fails once a fifth of the crawl deviates", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/post-slashed-${pad(i)}/`, 6),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.value).toBe(6);
  });

  test("the finding names the minority form against the dominant one", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/post-slashed-${pad(i)}/`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.items?.[0]?.label).toContain("3 of 23 page(s) use a trailing slash");
    expect(check.items?.[0]?.label).toContain("norm is no trailing slash");
  });

  test("dual paths agree regardless of crawl order", async () => {
    const deviants = template((i) => `/blog/post-slashed-${pad(i)}/`, 3);
    const majority = template((i) => `/blog/post-${pad(i)}`, 20);
    const first = await bothPaths([...majority, ...deviants]);
    const second = await bothPaths([...deviants, ...majority]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("url/slug-convention — precedence over the per-page url rules", () => {
  test("defers uppercase deviants to url/lowercase", async () => {
    // url/lowercase already warns on every one of these paths; flagging them here
    // too would accuse the site twice for one root cause.
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/Legacy-Post-${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(itemFor(check, "case")).toBeUndefined();
    expect(check.details?.deferredTo).toEqual(["case -> url/lowercase"]);
    expect(check.message).toContain("deferred to case -> url/lowercase");
  });

  test("defers snake_case deviants to url/hyphens", async () => {
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, 20),
      ...template((i) => `/blog/legacy_post_${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(itemFor(check, "separator")).toBeUndefined();
    expect(check.details?.deferredTo).toEqual(["separator -> url/hyphens"]);
  });

  test("still reports a kebab minority on a snake_case site", async () => {
    // url/hyphens flags the snake_case MAJORITY here, never these pages, so this
    // rule and that one are talking about disjoint sets.
    const specs = [
      ...template((i) => `/blog/post_number_${pad(i)}`, 20),
      ...template((i) => `/blog/post-number-${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    const item = itemFor(check, "separator") as { meta: Record<string, unknown> } | undefined;
    expect(item?.meta.value).toBe("kebab");
    expect(item?.meta.norm).toBe("snake");
  });

  test("leaves file URLs to url/trailing-slash", async () => {
    // A .html path with a trailing slash is url/trailing-slash's finding; this
    // rule's trailing-slash dimension never sees extension-bearing paths.
    const specs = [
      ...template((i) => `/docs/page-${pad(i)}.html`, 12),
      ...template((i) => `/docs/legacy-${pad(i)}.html/`, 4),
    ];
    const check = await bothPaths(specs);
    const norms = check.details?.norms as { dimension: string }[];
    expect(norms.some((n) => n.dimension === "trailing-slash")).toBe(false);
  });
});

describe("url/slug-convention — empty crawl", () => {
  test("legacy path with no pages skips", async () => {
    const result = await checks(legacyCtx([]));
    expect(result[0]?.status).toBe("skipped");
  });
});
