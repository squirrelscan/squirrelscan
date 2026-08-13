// core/canonical-form-drift — canonicals that disagree in form across the site (#1366).
//
// The rule accuses a site of contradicting itself, so most of this file defends
// the silence cases: a small crawl, too few comparable canonicals, a site that
// genuinely mixes forms, template-uniform pages, and every canonical shape that
// core/canonical or core/canonical-header already owns. The positive cases pin
// the one thing it is for: a minority of pages emitting a different URL form
// from the rest of the site.
//
// Every fixture runs through `bothPaths`, so the legacy `ctx.site.pages` path and
// the streaming `SiteQuery` path are asserted byte-identical on all of them.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import {
  CANONICAL_FORM_MIN_PAGES,
  CANONICAL_FORM_MIN_SAMPLE,
  canonicalFormDriftRule,
} from "../src/core/canonical-form-drift";
import type { ParsedPage, RuleContext } from "../src/types";

interface PageSpec {
  /** The page's own crawled URL; defaults to `https://example.com/pNNN`. */
  url?: string;
  canonical: string | null;
  status?: number;
}

function url(i: number): string {
  return `https://example.com/p${String(i).padStart(3, "0")}`;
}

/** N pages whose canonical is `prefix + path`, self-referential in the given form. */
function uniform(count: number, canonical: (i: number) => string | null): PageSpec[] {
  return Array.from({ length: count }, (_, i) => ({ canonical: canonical(i) }));
}

/** The healthy shape this site keeps: apex host, https, no trailing slash, no params. */
function healthy(i: number): string {
  return url(i);
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
        url: spec.url ?? url(i),
        statusCode: spec.status ?? 200,
        parsed: { meta: { canonical: spec.canonical } } as unknown as ParsedPage,
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function featureRow(spec: PageSpec, i: number): PageFeatureRow {
  return {
    normalizedUrl: spec.url ?? url(i),
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: null,
    schemaTypes: [],
    robotsNoindex: false,
    canonical: spec.canonical,
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
    throw new Error("canonical-form-drift must not use this SiteQuery method");
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
  return (await Promise.resolve(canonicalFormDriftRule.run(ctx))).checks;
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

/** `total` pages in the healthy form, except the last `drifted` in `other` form. */
function mostly(
  total: number,
  drifted: number,
  other: (i: number) => string
): PageSpec[] {
  return Array.from({ length: total }, (_, i) => ({
    canonical: i < total - drifted ? healthy(i) : other(i),
  }));
}

describe("core/canonical-form-drift — silence guards", () => {
  test("skips a crawl below the site page floor", async () => {
    const check = await bothPaths(uniform(CANONICAL_FORM_MIN_PAGES - 1, healthy));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${CANONICAL_FORM_MIN_PAGES} needed`);
  });

  test("a single-page site never fires", async () => {
    const check = await bothPaths([{ canonical: "https://example.com/" }]);
    expect(check.status).toBe("skipped");
  });

  test("skips when too few pages carry a comparable canonical", async () => {
    // 20 pages crawled, but only 9 declare a canonical at all: no dimension
    // reaches its sample floor, so there is nothing to form a norm from.
    const specs = [
      ...uniform(9, healthy),
      ...uniform(11, () => null),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain(`${CANONICAL_FORM_MIN_SAMPLE} comparable pages`);
  });

  test("skips a site that genuinely mixes every form 50/50 — no dominant norm", async () => {
    // Nothing here is a majority on any axis, so nothing here is a deviant.
    const specs = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { canonical: url(i) }
        : { canonical: `http://www.example.com/p${String(i).padStart(3, "0")}/?utm_source=x` }
    );
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("70%");
  });

  test("an axis just under the agreement threshold is dropped, not judged", async () => {
    // 13 of 20 = 65% < 70%: the majority is not enough to call the other 7 wrong.
    // The three axes the site IS consistent on are still judged, and pass.
    const check = await bothPaths(mostly(20, 7, (i) => `${url(i)}/`));
    expect(check.status).toBe("pass");
    expect(
      (check.details?.norms as { dimension: string }[]).map((n) => n.dimension)
    ).toEqual(["scheme", "host", "tracking params"]);
  });

  test("non-2xx pages are excluded from the norm and never flagged", async () => {
    const specs = [
      ...uniform(12, healthy),
      ...Array.from({ length: 3 }, (_, i) => ({
        canonical: `http://www.example.com/gone${i}/`,
        status: 404,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(12);
  });
});

describe("core/canonical-form-drift — validity belongs to core/canonical", () => {
  test("missing canonicals are not drift", async () => {
    const specs = [...uniform(12, healthy), ...uniform(6, () => null)];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(12);
  });

  test("relative canonicals are not drift", async () => {
    const specs = [...uniform(12, healthy), ...uniform(6, (i) => `/p${i}`)];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(12);
  });

  test("unparseable canonicals are not drift", async () => {
    const specs = [...uniform(12, healthy), ...uniform(6, () => "https://[not a url")];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(12);
  });

  test("cross-domain canonicals are not drift", async () => {
    // Syndicated pages canonicalising to the origin publisher use that site's
    // conventions (http, www, trailing slash) — comparing them here would report
    // core/canonical's finding a second time under a different name.
    const specs = [
      ...uniform(12, healthy),
      ...uniform(6, (i) => `http://www.origin-publisher.com/story-${i}/`),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details?.judgedPages).toBe(12);
  });
});

describe("core/canonical-form-drift — template-uniform pages sit inside the norm", () => {
  test("passes when every canonical shares one form", async () => {
    const check = await bothPaths(uniform(30, healthy));
    expect(check.status).toBe("pass");
    expect(check.items).toBeUndefined();
    expect(check.value).toBe(30);
    expect(check.message).toContain("scheme https");
    expect(check.message).toContain("host apex");
    expect(check.message).toContain("trailing slash in / no trailing slash");
    expect(check.message).toContain("tracking params tracking params stripped");
  });

  test("a consistently param-bearing form is a form, not drift", async () => {
    // Every canonical keeps the same tracking parameter. Ugly, but the site is
    // not contradicting itself, and this rule only reports contradictions.
    const check = await bothPaths(uniform(30, (i) => `${url(i)}?utm_source=newsletter`));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("tracking params tracking params retained");
  });

  test("a consistently www + trailing-slash site is clean", async () => {
    const check = await bothPaths(
      uniform(30, (i) => `https://www.example.com/p${String(i).padStart(3, "0")}/`)
    );
    expect(check.status).toBe("pass");
    expect(check.message).toContain("host www");
    expect(check.message).toContain("trailing slash in / trailing slash");
  });

  test("the site root and file-like paths do not join the trailing-slash norm", async () => {
    // "/" and "/feed.xml" have no trailing-slash choice to make, so they must not
    // be counted as deviants of a site that otherwise uses trailing slashes.
    const specs = [
      ...uniform(12, (i) => `https://example.com/p${String(i).padStart(3, "0")}/`),
      { url: "https://example.com/", canonical: "https://example.com/" },
      { url: "https://example.com/feed.xml", canonical: "https://example.com/feed.xml" },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    const slashNorm = (check.details?.norms as { dimension: string; pages: number }[]).find(
      (n) => n.dimension === "trailing slash"
    );
    expect(slashNorm?.pages).toBe(12);
  });

  test("a section that uses trailing slashes does not make the section that does not a deviant", async () => {
    // The expensive false positive this rule has to avoid: /blog/ pages with a
    // trailing slash and top-level /product pages without one is a normal shape,
    // not a site contradicting itself. Each section is judged against itself.
    const specs = [
      ...Array.from({ length: 21 }, (_, i) => ({
        url: `https://example.com/product-${i}`,
        canonical: `https://example.com/product-${i}`,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        url: `https://example.com/blog/post-${i}/`,
        canonical: `https://example.com/blog/post-${i}/`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(
      (check.details?.norms as { dimension: string; scope: string; form: string }[])
        .filter((n) => n.dimension === "trailing slash")
        .map((n) => [n.scope, n.form])
    ).toEqual([
      ["/", "no trailing slash"],
      ["/blog", "trailing slash"],
    ]);
  });

  test("a section under the sample floor is dropped rather than judged by the rest of the site", async () => {
    const specs = [
      ...uniform(20, healthy),
      ...Array.from({ length: 4 }, (_, i) => ({
        url: `https://example.com/blog/post-${i}/`,
        canonical: `https://example.com/blog/post-${i}/`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(
      (check.details?.norms as { dimension: string; scope: string }[])
        .filter((n) => n.dimension === "trailing slash")
        .map((n) => n.scope)
    ).toEqual(["/"]);
  });

  test("query strings that are not tracking parameters never split the norm", async () => {
    // A paginated listing legitimately canonicalises to `?page=N`.
    const check = await bothPaths(uniform(30, (i) => `${url(i)}?page=${i}`));
    expect(check.status).toBe("pass");
    expect(check.message).toContain("tracking params tracking params stripped");
  });
});

describe("core/canonical-form-drift — drift", () => {
  test("warns and names the ratio it is arguing from", async () => {
    const check = await bothPaths(mostly(30, 4, (i) => `${url(i)}/`));
    expect(check.status).toBe("warn");
    expect(check.value).toBe(4);
    expect(check.message).toContain(
      "4 of 30 canonical(s) are declared in a different form than the rest of the site"
    );
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.label).toBe(
      "26 of 30 canonicals in / use no trailing slash, these 4 use trailing slash"
    );
    expect(check.items?.[0]?.sourcePages).toHaveLength(4);
    expect(check.items?.[0]?.meta).toEqual({
      dimension: "trailing slash",
      scope: "/",
      norm: "no trailing slash",
      deviant: "trailing slash",
      have: 26,
      total: 30,
      drifted: 4,
    });
  });

  test("catches www drift against an apex norm", async () => {
    const check = await bothPaths(
      mostly(30, 4, (i) => `https://www.example.com/p${String(i).padStart(3, "0")}`)
    );
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.meta?.dimension).toBe("host");
    expect(check.items?.[0]?.meta?.deviant).toBe("www");
  });

  test("catches http drift against an https norm", async () => {
    const check = await bothPaths(
      mostly(30, 4, (i) => `http://example.com/p${String(i).padStart(3, "0")}`)
    );
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.meta?.dimension).toBe("scheme");
    expect(check.items?.[0]?.meta?.deviant).toBe("http");
  });

  test("catches tracking parameters retained on a minority of canonicals", async () => {
    const check = await bothPaths(mostly(30, 4, (i) => `${url(i)}?utm_campaign=spring`));
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.meta?.dimension).toBe("tracking params");
    expect(check.items?.[0]?.meta?.deviant).toBe("tracking params retained");
  });

  test("drift INSIDE a section is still caught, and named against that section", async () => {
    const specs = [
      ...uniform(20, healthy),
      ...Array.from({ length: 14 }, (_, i) => ({
        url: `https://example.com/blog/post-${i}`,
        canonical: `https://example.com/blog/post-${i}${i < 12 ? "/" : ""}`,
      })),
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.label).toBe(
      "12 of 14 canonicals in /blog use trailing slash, these 2 use no trailing slash"
    );
    expect(check.items?.[0]?.meta?.scope).toBe("/blog");
  });

  test("fails once the drifted share crosses the fail threshold", async () => {
    // 21 of 30 keep the norm (70%, exactly the agreement floor) → 9/30 = 30%.
    const check = await bothPaths(mostly(30, 9, (i) => `${url(i)}/`));
    expect(check.status).toBe("fail");
    expect(check.value).toBe(9);
  });

  test("a page drifting on two axes counts once toward the drifted share", async () => {
    const check = await bothPaths(
      mostly(30, 4, (i) => `http://www.example.com/p${String(i).padStart(3, "0")}`)
    );
    // Two drifts reported (scheme + host), but 4 drifted pages, not 8.
    expect(check.items).toHaveLength(2);
    expect(check.value).toBe(4);
    expect(check.details?.flaggedPages).toBe(4);
  });

  test("reports the widest drift first", async () => {
    const specs = Array.from({ length: 40 }, (_, i) => {
      if (i >= 34) return { canonical: `${url(i)}/` }; // 6 slash drifts
      if (i >= 32) return { canonical: `http://example.com/p${String(i).padStart(3, "0")}` }; // 2 scheme drifts
      return { canonical: healthy(i) };
    });
    const check = await bothPaths(specs);
    expect(check.items?.map((item) => item.meta?.dimension)).toEqual([
      "trailing slash",
      "scheme",
    ]);
  });
});

describe("core/canonical-form-drift — legacy-path edge cases", () => {
  test("an empty site skips rather than throwing", async () => {
    const result = await checks(legacyCtx([]));
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("skipped");
    expect(result[0]?.message).toBe("No pages available for analysis");
  });

  test("a page with no parsed meta skips rather than throwing", async () => {
    const ctx = legacyCtx(uniform(12, healthy));
    ctx.site!.pages[0]!.parsed = {} as unknown as ParsedPage;
    const result = await checks(ctx);
    expect(result[0]?.status).toBe("pass");
    expect(result[0]?.details?.judgedPages).toBe(11);
  });
});
