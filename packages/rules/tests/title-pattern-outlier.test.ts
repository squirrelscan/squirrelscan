// content/title-pattern-outlier — title templates vs the site's own norm (#1361).
//
// The rule's whole value is what it does NOT say, so most of this file defends the
// silence cases: a small crawl, too few titled pages, a site whose titles follow no
// template, a section label that is not the brand, and the homepage's own title. The
// positive cases pin the four deviations it is for.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  titlePatternOutlierRule,
  TITLE_NORM_MIN_AGREEMENT,
  TITLE_NORM_MIN_PAGES,
  TITLE_NORM_MIN_SAMPLE,
} from "../src/content/title-pattern-outlier";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  path: string;
  title?: string | null;
  status?: number;
}

function url(path: string): string {
  return `https://example.com${path}`;
}

function pad(i: number): string {
  return String(i).padStart(3, "0");
}

/** N pages sharing one path + title template, numbered so each url is distinct. */
function template(
  makePath: (i: number) => string,
  makeTitle: (i: number) => string,
  count: number
): PageSpec[] {
  return Array.from({ length: count }, (_, i) => ({ path: makePath(i), title: makeTitle(i) }));
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
        parsed: { meta: { title: spec.title ?? null } } as unknown as ParsedPage,
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
    title: spec.title ?? null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: null,
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
    throw new Error("title-pattern-outlier must not use this SiteQuery method");
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
  return (await Promise.resolve(titlePatternOutlierRule.run(ctx))).checks;
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

/** The item for a deviation class, or undefined when it was not reported. */
function itemFor(check: CheckResult, deviation: string): { meta: Record<string, unknown> } | undefined {
  return check.items?.find((i) => i.meta?.deviation === deviation) as
    | { meta: Record<string, unknown> }
    | undefined;
}

/** The canonical healthy corpus: two sections, one template, brand as a suffix. */
function uniformSite(count = 20): PageSpec[] {
  const half = Math.ceil(count / 2);
  return [
    ...template((i) => `/deals/offer-${pad(i)}`, (i) => `Offer ${pad(i)} | Acme Deals`, half),
    ...template(
      (i) => `/stores/store-${pad(i)}`,
      (i) => `Store ${pad(i)} | Acme Deals`,
      count - half
    ),
  ];
}

describe("content/title-pattern-outlier — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(uniformSite(TITLE_NORM_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${TITLE_NORM_MIN_PAGES} needed`);
  });

  test("skips when too few pages carry a title", async () => {
    const specs = [
      ...uniformSite(8),
      ...template((i) => `/misc/page-${pad(i)}`, () => "", 6),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("have a title");
    expect(check.message).toContain(`${TITLE_NORM_MIN_SAMPLE} needed`);
  });

  test("exactly at the site page floor the rule does judge", async () => {
    // The floor is the last silent crawl, not the first judged one.
    const check = await bothPaths(uniformSite(TITLE_NORM_MIN_PAGES));
    expect(check.status).toBe("pass");
  });

  test("skips a site whose titles follow no dominant template", async () => {
    // Every title is shaped differently: nothing here reaches the agreement bar, so
    // no page is a deviant. This is the no-false-positive fixture.
    const specs: PageSpec[] = [
      { path: "/a", title: "Welcome to our shop" },
      { path: "/b", title: "About | Widgets Inc" },
      { path: "/c", title: "Contact us today" },
      { path: "/d", title: "Blue Widget - Best Prices" },
      { path: "/e", title: "Widgets Inc :: Support" },
      { path: "/f", title: "How to choose a widget" },
      { path: "/g", title: "Shipping » Returns" },
      { path: "/h", title: "Careers at the company" },
      { path: "/i", title: "Press: our latest news" },
      { path: "/j", title: "Terms and conditions" },
      { path: "/k", title: "Widget catalogue 2026" },
      { path: "/l", title: "Store locator" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(
      `${Math.round(TITLE_NORM_MIN_AGREEMENT * 100)}% agreement`
    );
  });

  test("a section label is not mistaken for the brand", async () => {
    // 16 of 20 titles start with "Blog", but only inside /blog — a section label,
    // not a site brand, so the 4 shop pages are not accused of omitting it.
    const specs = [
      ...template((i) => `/blog/post-${pad(i)}`, (i) => `Blog | Post ${pad(i)}`, 16),
      ...template((i) => `/shop/item-${pad(i)}`, (i) => `Item ${pad(i)} for sale`, 4),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
  });

  test("non-2xx pages never vote", async () => {
    const specs = [
      ...uniformSite(20),
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `/deals/gone-${pad(i)}`,
        title: "404 Not Found",
        status: 404,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("untitled pages are left to core/meta-title", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/untitled-${pad(i)}`, () => null as unknown as string, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(20);
  });
});

describe("content/title-pattern-outlier — the no-false-positive fixtures", () => {
  test("template-uniform siblings sit inside the norm", async () => {
    const check = await bothPaths(uniformSite(30));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("follow the site's own title template");
    const norms = check.details?.norms as { dimension: string; norm: string }[];
    expect(norms.find((n) => n.dimension === "brand")?.norm).toBe("Acme Deals");
    expect(norms.find((n) => n.dimension === "separator")?.norm).toBe("|");
  });

  test("a uniformly brand-first site stays clean", async () => {
    // The non-default order IS this site's order, so there is no minority to report.
    const specs = [
      ...template((i) => `/deals/offer-${pad(i)}`, (i) => `Acme Deals - Offer ${pad(i)}`, 10),
      ...template((i) => `/stores/store-${pad(i)}`, (i) => `Acme Deals - Store ${pad(i)}`, 10),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    const norms = check.details?.norms as { dimension: string; norm: string; position?: string }[];
    expect(norms.find((n) => n.dimension === "brand")?.position).toBe("prefix");
    expect(norms.find((n) => n.dimension === "separator")?.norm).toBe("-");
  });

  test("the homepage keeps its own title", async () => {
    // "Acme Deals - the best deals" is brand-first with a different separator on a
    // brand-last site: normal for a home page, never a finding.
    const specs = [
      ...uniformSite(20),
      { path: "/", title: "Acme Deals - the best deals in Australia" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("a title that mentions the brand mid-string is not a deviant", async () => {
    const specs = [
      ...uniformSite(20),
      { path: "/deals/about", title: "About Acme Deals | Acme Deals" },
      { path: "/deals/why", title: "Why shop with Acme Deals and save" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("hyphenated words and clock times are not separators", async () => {
    const specs = [
      ...template(
        (i) => `/deals/offer-${pad(i)}`,
        (i) => `E-commerce deal ${pad(i)} at 10:30 | Acme Deals`,
        10
      ),
      ...template(
        (i) => `/stores/store-${pad(i)}`,
        (i) => `Store ${pad(i)} | Acme Deals`,
        10
      ),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });
});

describe("content/title-pattern-outlier — findings", () => {
  test("warns on a pocket of pages missing the brand", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy offer ${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(itemFor(check, "brand-missing")?.meta.pageCount).toBe(3);
    expect(check.items?.[0]?.label).toContain('never mention "Acme Deals"');
  });

  test("warns on a different separator against the modal one", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy ${pad(i)} - Acme Deals`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    const item = itemFor(check, "separator");
    expect(item?.meta.value).toBe("-");
    expect(item?.meta.pageCount).toBe(3);
    expect(check.items?.[0]?.label).toContain('the norm is "|"');
  });

  test("warns on an inverted brand order", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Acme Deals | Legacy ${pad(i)}`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(itemFor(check, "brand-position")?.meta.value).toBe("prefix");
    expect(check.items?.[0]?.label).toContain("first but the norm is last");
  });

  test("warns on brand-only titles away from the homepage", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/dupe-${pad(i)}`, () => "Acme Deals", 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(itemFor(check, "brand-only")?.meta.pageCount).toBe(3);
  });

  test("exactly at the agreement threshold a norm still exists", async () => {
    // 14 of 20 titles carry the brand — the boundary, not a comfortable majority.
    const specs = [
      ...template((i) => `/deals/offer-${pad(i)}`, (i) => `Offer ${pad(i)} | Acme Deals`, 7),
      ...template((i) => `/stores/store-${pad(i)}`, (i) => `Store ${pad(i)} | Acme Deals`, 7),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy offer ${pad(i)}`, 6),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.details?.flaggedPages).toBe(6);
    const norms = check.details?.norms as { dimension: string; agreement: number }[];
    expect(norms.find((n) => n.dimension === "brand")?.agreement).toBe(TITLE_NORM_MIN_AGREEMENT);
  });

  test("warn and fail sit either side of the deviant-share threshold", async () => {
    // 3/20 = 15% warns; 4/20 = 20% is exactly the threshold and fails.
    const warned = await bothPaths([
      ...uniformSite(17),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy offer ${pad(i)}`, 3),
    ]);
    expect(warned.status).toBe("warn");
    const failed = await bothPaths([
      ...uniformSite(16),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy offer ${pad(i)}`, 4),
    ]);
    expect(failed.status).toBe("fail");
  });

  test("templates that disagree with each other are the finding", async () => {
    // Three internally uniform templates that use three separators for the same
    // brand: uniformity inside a template does not exempt it from the site's norm.
    const specs = [
      ...template((i) => `/deals/offer-${pad(i)}`, (i) => `Offer ${pad(i)} :: Acme Deals`, 14),
      ...template((i) => `/stores/store-${pad(i)}`, (i) => `Store ${pad(i)} | Acme Deals`, 4),
      ...template((i) => `/blog/post-${pad(i)}`, (i) => `Post ${pad(i)} - Acme Deals`, 2),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    const norms = check.details?.norms as { dimension: string; norm: string }[];
    expect(norms.find((n) => n.dimension === "separator")?.norm).toBe("::");
    expect(check.details?.flaggedPages).toBe(6);
  });

  test("an unrecognised joiner casts no separator vote", async () => {
    // The rule only reports a separator it can actually read; a title joined by
    // something outside its vocabulary is never accused of using the wrong one.
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy ${pad(i)} ~ Acme Deals`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
  });

  test("fails once a fifth of the titled pages deviate", async () => {
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy offer ${pad(i)}`, 6),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("fail");
    expect(check.value).toBe(6);
    expect(check.details?.flaggedPages).toBe(6);
  });

  test("each page is accused once, for its most meaningful deviation", async () => {
    // These pages both omit the brand and use another separator: only the missing
    // brand is reported.
    const specs = [
      ...uniformSite(20),
      ...template((i) => `/deals/legacy-${pad(i)}`, (i) => `Legacy ${pad(i)} - Old Site`, 3),
    ];
    const check = await bothPaths(specs);
    expect(check.value).toBe(3);
    expect(itemFor(check, "brand-missing")?.meta.pageCount).toBe(3);
    expect(itemFor(check, "separator")).toBeUndefined();
  });

  test("dual paths agree regardless of crawl order", async () => {
    const deviants = template(
      (i) => `/deals/legacy-${pad(i)}`,
      (i) => `Legacy offer ${pad(i)}`,
      3
    );
    const majority = uniformSite(20);
    const first = await bothPaths([...majority, ...deviants]);
    const second = await bothPaths([...deviants, ...majority]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("content/title-pattern-outlier — empty crawl", () => {
  test("legacy path with no pages skips", async () => {
    const result = await checks(legacyCtx([]));
    expect(result[0]?.status).toBe("skipped");
  });
});
