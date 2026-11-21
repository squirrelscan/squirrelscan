// links/nav-set-divergence: pages missing navigation links the rest of the site has.
// Pages are real parsed HTML, so the legacy path derives each set with the function the streaming
// engine stores; the streaming ctx is fed rows carrying those stored sets.

import type {
  CheckResult,
  PageFeatureRow,
  SiteQuery,
} from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import {
  navSetDivergenceRule,
  pageNavLinkSet,
  NAV_MIN_PAGES,
  NAV_SET_MAX_HREFS,
} from "../src/links/nav-set-divergence";

const u = (path: string) => `https://example.com${path}`;

const SITE_NAV = [
  "/",
  "/pricing",
  "/about",
  "/blog",
  "/contact",
  "/features",
  "/careers",
  "/security",
  "/changelog",
  "/help",
];

interface Spec {
  path: string;
  html: string;
  status?: number;
  pageType?: string;
}

function anchors(paths: string[]): string {
  return paths.map((p) => `<a href="${p}">${p}</a>`).join(" ");
}

/** Header carries the first six links, footer the rest, so both chrome sections are exercised. */
function pageHtml(nav: string[], extra = ""): string {
  const header = nav.slice(0, 6);
  const footer = nav.slice(6);
  return `<!DOCTYPE html><html><head><title>t</title></head><body><header><nav>${anchors(header)}</nav></header><main><h1>Page</h1><p>Body copy. <a href="/body-only">in text</a></p>${extra}</main><footer>${anchors(footer)}</footer></body></html>`;
}

/** A standard page: the shared nav, minus any entry for the page itself (the active item). */
function normal(path: string, pageType?: string): Spec {
  return { path, html: pageHtml(SITE_NAV.filter((p) => p !== path)), pageType };
}

function normals(n: number): Spec[] {
  const targets = SITE_NAV.slice(1, 6).map((p) => normal(p));
  const filler = Array.from(
    { length: Math.max(0, n - targets.length - 1) },
    (_, i) => normal(`/p${i}`)
  );
  return [normal("/"), ...targets, ...filler].slice(0, n);
}

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: u("/"),
      pages: specs.map((s) => {
        const parsed = parsePage(s.html, u(s.path));
        if (s.pageType) parsed.pageType = s.pageType as typeof parsed.pageType;
        return {
          url: u(s.path),
          statusCode: s.status ?? 200,
          parsed,
          headers: {},
        };
      }),
      robotsTxt: null,
      sitemaps: null,
      siteIndexable: true,
    },
  } as unknown as RuleContext;
}

function row(s: Spec): PageFeatureRow {
  const parsed = parsePage(s.html, u(s.path));
  return {
    normalizedUrl: u(s.path),
    status: s.status ?? 200,
    pageType: s.pageType ?? parsed.pageType ?? null,
    navLinkSet: pageNavLinkSet(parsed, u(s.path)),
  } as PageFeatureRow;
}

function streamCtx(specs: Spec[]): RuleContext {
  const rows = specs.map(row);
  const unused = (): never => {
    throw new Error("nav-set-divergence must not use this SiteQuery method");
  };
  const siteQuery = {
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
  } as unknown as SiteQuery;
  return {
    page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: u("/"),
      pages: [],
      robotsTxt: null,
      sitemaps: null,
      siteIndexable: true,
    },
    siteQuery,
  } as unknown as RuleContext;
}

async function run(ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(navSetDivergenceRule.run(ctx))).checks;
}

/** Runs both paths and requires byte-identical output. */
async function bothPaths(specs: Spec[]): Promise<CheckResult> {
  const legacy = await run(legacyCtx(specs));
  const streamed = await run(streamCtx(specs));
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

describe("pageNavLinkSet", () => {
  test("keeps internal chrome links, drops fragments, the page's own URL and body links", () => {
    const html = `<html><body><header><a href="/a#x">a</a><a href="/a">a2</a><a href="/self">self</a><a href="https://other.test/x">ext</a></header><main><a href="/body">b</a></main><footer><a href="/z">z</a></footer></body></html>`;
    const set = pageNavLinkSet(parsePage(html, u("/self")), u("/self"));
    expect(set?.hrefs).toEqual([u("/a"), u("/z")]);
    expect(set?.count).toBe(2);
    expect(set?.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("falls back to isChrome when a link has no section, and ignores broken links", () => {
    const set = pageNavLinkSet(
      {
        links: [
          { url: u("/b"), text: "b", isInternal: true, isChrome: true },
          { url: u("/a"), text: "a", isInternal: true, isChrome: true },
          { url: u("/c"), text: "c", isInternal: true },
          {
            url: u("/d"),
            text: "d",
            isInternal: true,
            isChrome: true,
            error: "boom",
          },
          {
            url: u("/e"),
            text: "e",
            isInternal: true,
            isChrome: true,
            section: "content",
          },
        ],
      },
      u("/x")
    );
    expect(set?.hrefs).toEqual([u("/a"), u("/b")]);
  });

  test("is null with no links array or no chrome links, and oversized sets keep only count and hash", () => {
    expect(pageNavLinkSet({}, u("/x"))).toBeNull();
    expect(pageNavLinkSet(undefined, u("/x"))).toBeNull();
    expect(
      pageNavLinkSet(
        { links: [{ url: u("/c"), text: "c", isInternal: true }] },
        u("/x")
      )
    ).toBeNull();
    const big = Array.from({ length: NAV_SET_MAX_HREFS + 1 }, (_, i) => ({
      url: u(`/n${i}`),
      text: "n",
      isInternal: true,
      section: "header" as const,
    }));
    const set = pageNavLinkSet({ links: big }, u("/x"));
    expect(set?.count).toBe(NAV_SET_MAX_HREFS + 1);
    expect(set?.hrefs).toEqual([]);
  });
});

describe("links/nav-set-divergence", () => {
  test("pass: a uniform site, including nav targets whose own link is absent", async () => {
    const check = await bothPaths(normals(12));
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({
      judgedPages: 12,
      flaggedPages: 0,
      oversizedPages: 0,
    });
  });

  test("warn: a page missing two navigation links lists exactly those hrefs", async () => {
    const odd: Spec = {
      path: "/odd",
      html: pageHtml(SITE_NAV.filter((p) => p !== "/careers" && p !== "/help")),
    };
    const check = await bothPaths([...normals(11), odd]);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.id).toBe(u("/odd"));
    expect(check.items?.[0]?.meta).toMatchObject({
      missingHrefs: [u("/careers"), u("/help")],
      missingCount: 2,
      normSize: SITE_NAV.length,
      comparedWithin: "site",
    });
    expect(check.items?.[0]?.label).toContain("Missing 2 of 10");
    expect(check.items?.[0]?.label).toContain(u("/careers"));
  });

  test("fail: a page that lost most of the navigation", async () => {
    const odd: Spec = {
      path: "/stripped",
      html: pageHtml(["/", "/pricing", "/about", "/blog"]),
    };
    const check = await bothPaths([...normals(11), odd]);
    expect(check.status).toBe("fail");
    expect(check.items?.[0]?.meta).toMatchObject({ missingCount: 6 });
  });

  test("a page with no navigation at all is counted, not compared", async () => {
    const bare: Spec = {
      path: "/bare",
      html: "<html><body><main><p>hi</p></main></body></html>",
    };
    const check = await bothPaths([...normals(12), bare]);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({
      pagesWithoutNav: 1,
      judgedPages: 12,
    });
  });

  test("skipped: below the page floor", async () => {
    const check = await bothPaths(normals(NAV_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("crawled");
  });

  test("skipped: no clear norm when every page has its own navigation", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({
      path: `/h${i}`,
      html: pageHtml([`/a${i}`, `/b${i}`, `/c${i}`]),
    }));
    const check = await bothPaths(specs);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("No clear navigation norm");
  });

  test("skipped: too few pages carry a navigation set", async () => {
    const bare = Array.from({ length: 8 }, (_, i) => ({
      path: `/b${i}`,
      html: "<html><body><p>hi</p></body></html>",
    }));
    const check = await bothPaths([...normals(6), ...bare]);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("carry navigation links");
  });

  test("a docs section with its own navigation is compared within its page type, not flagged", async () => {
    const DOCS_NAV = [
      "/docs",
      "/docs/start",
      "/docs/api",
      "/docs/cli",
      "/docs/faq",
      "/pricing",
      "/docs/a",
      "/docs/b",
    ];
    const marketing = normals(8).map((s) => ({ ...s, pageType: "landing" }));
    const docs = Array.from({ length: 6 }, (_, i) => ({
      path: `/docs/g${i}`,
      html: pageHtml(DOCS_NAV),
      pageType: "docs",
    }));
    const check = await bothPaths([...marketing, ...docs]);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({
      judgedPages: 14,
      flaggedPages: 0,
      unjudgedPages: 0,
    });
  });

  test("a docs page missing its own sidebar link is flagged within the docs type", async () => {
    const DOCS_NAV = [
      "/docs",
      "/docs/start",
      "/docs/api",
      "/docs/cli",
      "/docs/faq",
      "/pricing",
      "/docs/a",
      "/docs/b",
    ];
    const marketing = normals(8).map((s) => ({ ...s, pageType: "landing" }));
    const docs: Spec[] = Array.from({ length: 6 }, (_, i) => ({
      path: `/docs/g${i}`,
      html: pageHtml(
        i === 0 ? DOCS_NAV.filter((p) => p !== "/docs/api") : DOCS_NAV
      ),
      pageType: "docs",
    }));
    const check = await bothPaths([...marketing, ...docs]);
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.id).toBe(u("/docs/g0"));
    expect(check.items?.[0]?.meta).toMatchObject({
      comparedWithin: "pageType:docs",
      missingHrefs: [u("/docs/api")],
    });
  });

  test("a large section with no shared navigation is left unjudged", async () => {
    const mixed = Array.from({ length: 6 }, (_, i) => ({
      path: `/m${i}`,
      html: pageHtml([`/x${i}`, `/y${i}`, `/z${i}`]),
      pageType: "docs",
    }));
    const check = await bothPaths([...normals(16), ...mixed]);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ unjudgedPages: 6, judgedPages: 16 });
  });

  describe("localized sections", () => {
    const FR_NAV = [
      "/fr/",
      "/fr/tarifs",
      "/fr/a-propos",
      "/fr/blog",
      "/fr/contact",
      "/fr/aide",
      "/fr/carrieres",
    ];
    const frPage = (path: string, nav = FR_NAV): Spec => ({
      path,
      html: pageHtml(nav.filter((p) => p !== path)),
    });
    const french = (nav = FR_NAV): Spec[] => [
      frPage("/fr/", nav),
      frPage("/fr/tarifs", nav),
      frPage("/fr/a-propos", nav),
      frPage("/fr/blog", nav),
      frPage("/fr/contact", nav),
    ];

    test("French pages with a French nav are not held to the English nav", async () => {
      const check = await bothPaths([...normals(12), ...french()]);
      expect(check.status).toBe("pass");
      expect(check.details).toMatchObject({
        judgedPages: 17,
        flaggedPages: 0,
        unjudgedPages: 0,
      });
    });

    test("a French page missing a French nav link is flagged within its locale", async () => {
      const odd = frPage(
        "/fr/odd",
        FR_NAV.filter((p) => p !== "/fr/aide")
      );
      const check = await bothPaths([...normals(12), ...french(), odd]);
      expect(check.status).toBe("warn");
      expect(check.items).toHaveLength(1);
      expect(check.items?.[0]?.id).toBe(u("/fr/odd"));
      expect(check.items?.[0]?.meta).toMatchObject({
        comparedWithin: "locale:fr",
        missingHrefs: [u("/fr/aide")],
      });
    });

    test("a locale partition under the group floor is unjudged, not flagged", async () => {
      const de = ["/de/a", "/de/b", "/de/c"].map((path) => ({
        path,
        html: pageHtml(["/de/x"]),
      }));
      const check = await bothPaths([...normals(12), ...de]);
      expect(check.status).toBe("pass");
      expect(check.details).toMatchObject({
        judgedPages: 12,
        unjudgedPages: 3,
      });
    });
  });

  test("an oversized navigation is counted and not compared", async () => {
    const huge = Array.from(
      { length: NAV_SET_MAX_HREFS + 20 },
      (_, i) => `/mega${i}`
    );
    const check = await bothPaths([
      ...normals(12),
      { path: "/mega", html: pageHtml(huge) },
    ]);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ oversizedPages: 1, judgedPages: 12 });
  });

  test("error pages do not vote or get flagged", async () => {
    const gone: Spec = { path: "/gone", html: pageHtml(["/"]), status: 404 };
    const check = await bothPaths([...normals(12), gone]);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ judgedPages: 12 });
  });

  test("a row stored without a navigation set is not compared, and legacy with no pages skips", async () => {
    const ctx = streamCtx(normals(12));
    const rows = ctx.siteQuery as unknown as {
      pagesMatching: SiteQuery["pagesMatching"];
    };
    const first = rows.pagesMatching;
    rows.pagesMatching = async function* (pred) {
      for await (const r of first(pred)) {
        const { navLinkSet: _unused, ...rest } = r;
        yield rest as PageFeatureRow;
      }
    };
    expect((await run(ctx))[0]?.status).toBe("skipped");
    expect((await run(legacyCtx([])))[0]?.status).toBe("skipped");
  });

  test("output order does not depend on page order", async () => {
    const odd: Spec = {
      path: "/odd",
      html: pageHtml(SITE_NAV.filter((p) => p !== "/help")),
    };
    const specs = [...normals(11), odd];
    const a = await run(streamCtx(specs));
    const b = await run(streamCtx([...specs].reverse()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
