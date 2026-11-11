// content/duplicate-content: indexable pages serving identical body content (#1690).

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { duplicateContentRule, isPaginatedUrl, urlFormCauses } from "../src/content/duplicate-content";
import type { ParsedPage, RuleContext } from "../src/types";

interface Spec {
  url: string;
  hash?: string | null;
  words?: number;
  canonical?: string | null;
  status?: number;
  noindex?: boolean;
  reasons?: string[];
  hreflang?: { hreflang: string; href: string }[] | null;
}

function row(spec: Spec): PageFeatureRow {
  return {
    normalizedUrl: spec.url,
    status: spec.status ?? 200,
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: spec.hash === undefined ? "h1" : spec.hash,
    wordCount: spec.words ?? 200,
    pageType: null,
    schemaTypes: [],
    robotsNoindex: spec.noindex ?? false,
    canonical: spec.canonical ?? null,
    visibleAuthor: false,
    visibleDate: false,
    transferBytes: null,
    templateFp: null,
    secretHits: null,
    metaNoindex: false,
    indexableReasons: spec.reasons ?? (spec.noindex ? ["meta:noindex"] : []),
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
    hreflangAlternates: spec.hreflang ?? null,
  } as unknown as PageFeatureRow;
}

async function run(specs: Spec[], options: Record<string, unknown> = {}): Promise<CheckResult[]> {
  const rows = specs.map(row);
  const unused = (): never => {
    throw new Error("duplicate-content must not use this SiteQuery method");
  };
  const siteQuery: SiteQuery = {
    pageCount: () => rows.length,
    duplicateGroups: unused,
    incomingLinkCounts: unused,
    contextualIncomingLinkCounts: unused,
    pagesByType: unused,
    templateClusters: unused,
    sumTransferBytes: unused,
    sumSecretHits: unused,
    homepage: unused,
    async *pagesMatching(pred: (r: PageFeatureRow) => boolean) {
      for (const r of rows) if (pred(r)) yield r;
    },
  };
  const ctx = {
    page: { url: "https://x.test/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    siteQuery,
    site: { baseUrl: "https://x.test/", pages: [], robotsTxt: null, sitemaps: null },
    options,
  } as unknown as RuleContext;
  return (await duplicateContentRule.run(ctx)).checks;
}

const warn = (checks: CheckResult[]) => checks.find((c) => c.status === "warn");
const passes = (checks: CheckResult[]) => checks.length === 1 && checks[0]?.status === "pass";

describe("groups", () => {
  test("two indexable pages with one hash and different canonicals form one group listing every URL", async () => {
    const w = warn(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b" }, { url: "https://x.test/c", hash: "other" }]));
    expect(w?.message).toBe("1 group(s) of duplicate content across 2 pages");
    expect(w?.items).toHaveLength(1);
    expect(w?.items?.[0]?.sourcePages).toEqual(["https://x.test/a", "https://x.test/b"]);
    expect(w?.details).toMatchObject({ groups: 1, pages: 2, minWords: 50 });
  });

  test("a group where every page declares the same canonical is not reported", async () => {
    const canonical = "https://x.test/a";
    expect(passes(await run([{ url: "https://x.test/a", canonical }, { url: "https://x.test/b", canonical }]))).toBe(true);
  });

  test("a missing canonical counts as the page itself, so a copy pointing at it resolves the group", async () => {
    expect(passes(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b", canonical: "https://x.test/a" }]))).toBe(true);
  });

  test("a copy pointing somewhere else leaves two canonicals, so the group is reported", async () => {
    expect(warn(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b", canonical: "https://x.test/c" }]))).toBeDefined();
  });

  test("a relative canonical is resolved and a fragment is ignored", async () => {
    const checks = await run([
      { url: "https://x.test/a", canonical: "/a#top" },
      { url: "https://x.test/b", canonical: "https://x.test/a" },
    ]);
    expect(passes(checks)).toBe(true);
  });

  test("groups are ordered largest first and the result counts groups and pages", async () => {
    const w = warn(
      await run([
        { url: "https://x.test/s1", hash: "small" },
        { url: "https://x.test/s2", hash: "small" },
        { url: "https://x.test/b1", hash: "big" },
        { url: "https://x.test/b2", hash: "big" },
        { url: "https://x.test/b3", hash: "big" },
      ]),
    );
    expect(w?.message).toBe("2 group(s) of duplicate content across 5 pages");
    expect(w?.items?.map((i) => (i.meta as { pageCount: number }).pageCount)).toEqual([3, 2]);
  });

  test("equal-sized groups are ordered by first URL", async () => {
    const w = warn(
      await run([
        { url: "https://x.test/z1", hash: "z" },
        { url: "https://x.test/z2", hash: "z" },
        { url: "https://x.test/a1", hash: "a" },
        { url: "https://x.test/a2", hash: "a" },
      ]),
    );
    expect(w?.items?.map((i) => i.id)).toEqual(["https://x.test/a1", "https://x.test/z1"]);
  });
});

describe("what is left out", () => {
  test("noindex pages, by meta or header, leave every group", async () => {
    expect(passes(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b", noindex: true }]))).toBe(true);
    expect(passes(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b", reasons: ["header:noindex"] }]))).toBe(true);
  });

  test("redirects and error responses leave every group", async () => {
    for (const status of [301, 302, 404, 500]) {
      expect(passes(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b", status }]))).toBe(true);
    }
  });

  test("pages below the minimum word count are left out, and the option changes it", async () => {
    const specs = [{ url: "https://x.test/a", words: 30 }, { url: "https://x.test/b", words: 30 }];
    expect(passes(await run(specs))).toBe(true);
    expect(warn(await run(specs, { minWords: 10 }))).toBeDefined();
    expect(warn(await run([{ url: "https://x.test/a", words: 80 }, { url: "https://x.test/b", words: 80 }], { minWords: 100 }))).toBeUndefined();
  });

  test("pages with no content hash are left out", async () => {
    expect(passes(await run([{ url: "https://x.test/a", hash: null }, { url: "https://x.test/b", hash: null }]))).toBe(true);
  });

  test("paginated pages are not duplicates of one another", async () => {
    expect(
      passes(await run([{ url: "https://x.test/list?page=2" }, { url: "https://x.test/list/page/3/" }, { url: "https://x.test/other" }])),
    ).toBe(true);
  });

  test("reciprocal same-language hreflang variants are one page served per region", async () => {
    const gb = { url: "https://x.test/en-gb/a", hreflang: [{ hreflang: "en-us", href: "https://x.test/en-us/a" }] };
    const us = { url: "https://x.test/en-us/a", hreflang: [{ hreflang: "en-gb", href: "https://x.test/en-gb/a" }] };
    expect(passes(await run([gb, us]))).toBe(true);
  });

  test("a one-way hreflang reference proves nothing", async () => {
    const gb = { url: "https://x.test/en-gb/a", hreflang: [{ hreflang: "en-us", href: "https://x.test/en-us/a" }] };
    const us = { url: "https://x.test/en-us/a", hreflang: null };
    expect(warn(await run([gb, us]))).toBeDefined();
  });
});

describe("URL form as the cause", () => {
  test("tracking parameters, a trailing slash or letter case are named", async () => {
    const w = warn(await run([{ url: "https://x.test/a" }, { url: "https://x.test/a?utm_source=x" }]));
    expect(w?.items?.[0]?.label).toContain("the URL form is the cause (tracking parameters)");
    expect(w?.items?.[0]?.meta).toMatchObject({ urlFormCause: ["tracking-parameters"] });
    const slash = warn(await run([{ url: "https://x.test/a" }, { url: "https://x.test/a/" }]));
    expect(slash?.items?.[0]?.meta).toMatchObject({ urlFormCause: ["trailing-slash"] });
    const caseOnly = warn(await run([{ url: "https://x.test/About" }, { url: "https://x.test/about" }]));
    expect(caseOnly?.items?.[0]?.meta).toMatchObject({ urlFormCause: ["letter-case"] });
  });

  test("different pages carry no URL-form note", async () => {
    const w = warn(await run([{ url: "https://x.test/a" }, { url: "https://x.test/b" }]));
    expect(w?.items?.[0]?.label).toBe("2 pages with identical content");
    expect((w?.items?.[0]?.meta as Record<string, unknown>).urlFormCause).toBeUndefined();
  });

  test("urlFormCauses table", () => {
    const table: [string[], string[] | null][] = [
      [["https://x.test/a", "https://x.test/a?utm_medium=m&gclid=1"], ["tracking-parameters"]],
      [["https://x.test/a", "https://x.test/a/", "https://x.test/A"], ["trailing-slash", "letter-case"]],
      [["https://x.test/a?id=1", "https://x.test/a?id=2"], null],
      [["https://x.test/", "https://x.test"], null],
      [["https://x.test/a", "https://y.test/a"], null],
      [["https://x.test/a", "not a url"], null],
    ];
    for (const [urls, want] of table) expect(urlFormCauses(urls)).toEqual(want);
  });
});

describe("pagination urls", () => {
  const table: [string, boolean][] = [
    ["https://x.test/list?page=2", true],
    ["https://x.test/list?p=2", true],
    ["https://x.test/list?a=1&offset=20", true],
    ["https://x.test/list/page/2", true],
    ["https://x.test/list/page/2/", true],
    ["https://x.test/list", false],
    ["https://x.test/page/about", false],
    ["https://x.test/products?sort=asc", false],
  ];
  for (const [u, want] of table) test(u, () => expect(isPaginatedUrl(u)).toBe(want));
});

describe("small crawls, limits and determinism", () => {
  test("a single page is skipped with the reason", async () => {
    const checks = await run([{ url: "https://x.test/a" }]);
    expect(checks[0]).toMatchObject({ status: "skipped" });
  });

  test("a site with no duplicate groups passes", async () => {
    expect(passes(await run([{ url: "https://x.test/a", hash: "1" }, { url: "https://x.test/b", hash: "2" }]))).toBe(true);
  });

  test("listed groups and URLs are capped and the rest counted", async () => {
    const specs: Spec[] = [];
    for (let g = 0; g < 60; g++) for (let k = 0; k < 2; k++) specs.push({ url: `https://x.test/g${g}/k${k}`, hash: `h${g}` });
    const w = warn(await run(specs));
    expect(w?.items).toHaveLength(50);
    expect(w?.details).toMatchObject({ groups: 60, pages: 120, additional: 10 });

    const wide: Spec[] = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.test/w${i}` }));
    const w2 = warn(await run(wide));
    expect(w2?.items?.[0]?.sourcePages).toHaveLength(25);
    expect(w2?.items?.[0]?.meta).toMatchObject({ pageCount: 30, additionalPages: 5 });
  });

  test("without a SiteQuery or pages the rule gives no verdict", () => {
    const ctx = { page: { url: "https://x.test/" }, parsed: {}, options: {} } as unknown as RuleContext;
    const result = duplicateContentRule.run(ctx);
    expect(result instanceof Promise ? null : result.checks[0]?.status).toBe("skipped");
  });

  test("the same input gives the same result", async () => {
    const specs: Spec[] = [
      { url: "https://x.test/b" },
      { url: "https://x.test/a" },
      { url: "https://x.test/c", hash: "x" },
      { url: "https://x.test/d", hash: "x" },
    ];
    expect(JSON.stringify(await run(specs))).toBe(JSON.stringify(await run([...specs].reverse())));
  });
});

describe("the v1 path (site.pages) agrees with the streaming path", () => {
  interface PageSpec extends Spec {
    words: number;
  }

  function html(spec: PageSpec): string {
    const head = [
      spec.canonical ? `<link rel="canonical" href="${spec.canonical}">` : "",
      spec.noindex ? '<meta name="robots" content="noindex">' : "",
      ...(spec.hreflang ?? []).map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}">`),
    ].join("");
    return `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body><main><p>${"lorem ".repeat(spec.words)}</p></main></body></html>`;
  }

  async function legacy(specs: PageSpec[], options: Record<string, unknown> = {}): Promise<CheckResult[]> {
    const pages = specs.map((spec) => ({
      url: spec.url,
      statusCode: spec.status ?? 200,
      parsed: parsePage(html(spec), spec.url),
      headers: {},
      contentHash: spec.hash === undefined ? "h1" : spec.hash,
    }));
    const ctx = {
      page: { url: "https://x.test/", html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: { baseUrl: "https://x.test/", pages, robotsTxt: null, sitemaps: null },
      options,
    } as unknown as RuleContext;
    return (await duplicateContentRule.run(ctx)).checks;
  }

  const fixtures: [string, PageSpec[]][] = [
    ["two copies", [{ url: "https://x.test/a", words: 120 }, { url: "https://x.test/b", words: 120 }]],
    ["one canonical", [{ url: "https://x.test/a", words: 120, canonical: "https://x.test/a" }, { url: "https://x.test/b", words: 120, canonical: "https://x.test/a" }]],
    ["noindex copy", [{ url: "https://x.test/a", words: 120 }, { url: "https://x.test/b", words: 120, noindex: true }]],
    ["error copy", [{ url: "https://x.test/a", words: 120 }, { url: "https://x.test/b", words: 120, status: 404 }]],
    ["thin copies", [{ url: "https://x.test/a", words: 10 }, { url: "https://x.test/b", words: 10 }]],
    ["paginated", [{ url: "https://x.test/l?page=2", words: 120 }, { url: "https://x.test/l?page=3", words: 120 }]],
    ["tracking twin", [{ url: "https://x.test/a", words: 120 }, { url: "https://x.test/a?utm_source=x", words: 120 }]],
    [
      "region variants",
      [
        { url: "https://x.test/en-gb/a", words: 120, hreflang: [{ hreflang: "en-us", href: "https://x.test/en-us/a" }] },
        { url: "https://x.test/en-us/a", words: 120, hreflang: [{ hreflang: "en-gb", href: "https://x.test/en-gb/a" }] },
      ],
    ],
    ["no hashes", [{ url: "https://x.test/a", words: 120, hash: null }, { url: "https://x.test/b", words: 120, hash: null }]],
    ["one page", [{ url: "https://x.test/a", words: 120 }]],
    ["distinct", [{ url: "https://x.test/a", words: 120, hash: "1" }, { url: "https://x.test/b", words: 120, hash: "2" }]],
  ];

  for (const [name, specs] of fixtures) {
    test(name, async () => {
      expect(JSON.stringify(await legacy(specs))).toBe(JSON.stringify(await run(specs)));
    });
  }

  test("the minimum word count option reads parsed word counts the same way", async () => {
    const specs: PageSpec[] = [{ url: "https://x.test/a", words: 80 }, { url: "https://x.test/b", words: 80 }];
    expect(JSON.stringify(await legacy(specs, { minWords: 100 }))).toBe(JSON.stringify(await run(specs, { minWords: 100 })));
    expect(JSON.stringify(await legacy(specs, { minWords: 60 }))).toBe(JSON.stringify(await run(specs, { minWords: 60 })));
  });
});
