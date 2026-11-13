// content/voice-consistency: reading-level outliers against the site's own norm.
// Pages are real parsed HTML, so the legacy path derives the score with the same function the
// streaming engine stores; the streaming ctx is fed those stored scores.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";

import { pageReadingLevel } from "../src/content/reading-level";
import {
  voiceConsistencyRule,
  VOICE_MIN_PAGES,
  VOICE_MIN_SAMPLE,
} from "../src/content/voice-consistency";
import type { RuleContext } from "../src/types";

const PLAIN = "Every customer receives careful support during the first week of service. ";
const HARD =
  "Institutional comprehensiveness necessitates multidimensional organizational transformation considerations. ";
const EASY = "We like to run. The dog can jump. It is fun to play. ";
const MIXED = "Good tools make daily work simpler for busy families in every community. ";

function html(text: string, copies: number): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body><main><p>${text.repeat(copies)}</p></main></body></html>`;
}

interface Spec {
  path: string;
  html: string;
  status?: number;
  noindex?: boolean;
  pageType?: string;
}

const norm = (i: number): Spec => ({
  path: `/p${String(i).padStart(3, "0")}`,
  html: html(i % 2 === 0 ? PLAIN : MIXED, 12),
});

function normals(n: number): Spec[] {
  return Array.from({ length: n }, (_, i) => norm(i));
}

const u = (path: string) => `https://example.com${path}`;

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    page: { url: u("/"), html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {},
    options: {},
    site: {
      baseUrl: u("/"),
      pages: specs.map((s) => ({
        url: u(s.path),
        statusCode: s.status ?? 200,
        parsed: parsePage(
          s.noindex ? s.html.replace("<head>", '<head><meta name="robots" content="noindex">') : s.html,
          u(s.path),
        ),
        headers: {},
      })),
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
    depth: 1,
    title: null,
    titleHash: null,
    description: null,
    descHash: null,
    contentHash: null,
    wordCount: null,
    pageType: s.pageType ?? parsed.pageType ?? null,
    schemaTypes: [],
    robotsNoindex: !!s.noindex,
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
    hreflangAlternates: null,
    readingLevel: pageReadingLevel(parsed),
  } as PageFeatureRow;
}

function streamCtx(specs: Spec[]): RuleContext {
  const rows = specs.map(row);
  const unused = (): never => {
    throw new Error("voice-consistency must not use this SiteQuery method");
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
    site: { baseUrl: u("/"), pages: [], robotsTxt: null, sitemaps: null, siteIndexable: true },
    siteQuery,
  } as unknown as RuleContext;
}

async function run(ctx: RuleContext): Promise<CheckResult[]> {
  return (await Promise.resolve(voiceConsistencyRule.run(ctx))).checks;
}

async function bothPaths(specs: Spec[]): Promise<CheckResult> {
  const legacy = await run(legacyCtx(specs));
  const streamed = await run(streamCtx(specs));
  expect(JSON.stringify(streamed)).toBe(JSON.stringify(legacy));
  expect(legacy).toHaveLength(1);
  return legacy[0]!;
}

describe("content/voice-consistency", () => {
  test("fixtures read at the levels the tests assume", () => {
    const lvl = (t: string, n: number) => pageReadingLevel(parsePage(html(t, n), u("/x")))!;
    expect(Math.abs(lvl(PLAIN, 12) - lvl(MIXED, 12))).toBeLessThan(15);
    expect(lvl(PLAIN, 12) - lvl(HARD, 16)).toBeGreaterThanOrEqual(25);
    expect(lvl(EASY, 12) - lvl(PLAIN, 12)).toBeGreaterThanOrEqual(25);
  });

  test("a uniform site passes", async () => {
    const check = await bothPaths(normals(14));
    expect(check.status).toBe("pass");
  });

  test("a much harder page is flagged with its score and the site norm", async () => {
    const specs = [...normals(14), { path: "/odd", html: html(HARD, 16) }];
    const check = await bothPaths(specs);
    expect(check.status).toBe("info");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.id).toBe(u("/odd"));
    expect(check.items?.[0]?.label).toContain("harder");
    expect(check.items?.[0]?.label).toContain("site norm of");
    expect(check.items?.[0]?.meta).toMatchObject({ medianFlesch: expect.any(Number), fleschScore: expect.any(Number) });
  });

  test("a much easier page is flagged too", async () => {
    const check = await bothPaths([...normals(14), { path: "/kids", html: html(EASY, 12) }]);
    expect(check.status).toBe("info");
    expect(check.items?.[0]?.label).toContain("easier");
  });

  test("legal, privacy and terms pages are never flagged and are counted", async () => {
    const specs = [
      ...normals(14),
      { path: "/privacy", html: html(HARD, 16) },
      { path: "/terms-of-service", html: html(HARD, 16) },
      { path: "/legal", html: html(HARD, 16) },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ excludedLegalPages: 3 });
  });

  test("a stored page type of legal is excluded wherever the URL sits", async () => {
    const specs = [...normals(14), { path: "/policies/page-7", html: html(HARD, 16), pageType: "legal" }];
    const check = (await run(streamCtx(specs)))[0]!;
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ excludedLegalPages: 1 });
  });

  test("a crawl below the page floor is skipped", async () => {
    const check = await bothPaths(normals(VOICE_MIN_PAGES - 1));
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("crawled");
  });

  test("too few scorable pages is skipped", async () => {
    const short = Array.from({ length: 12 }, (_, i) => ({ path: `/s${i}`, html: html("Hi there. ", 2) }));
    const check = await bothPaths([...normals(VOICE_MIN_SAMPLE - 1), ...short]);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("enough text to score");
  });

  test("no clear norm (two evenly split registers) is skipped, not guessed at", async () => {
    const half = Array.from({ length: 12 }, (_, i) => ({
      path: `/m${i}`,
      html: html(i % 2 === 0 ? HARD : EASY, i % 2 === 0 ? 16 : 12),
    }));
    const check = await bothPaths(half);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("do not cluster");
  });

  test("error pages and noindex pages do not vote or get flagged", async () => {
    const specs = [
      ...normals(14),
      { path: "/gone", html: html(HARD, 16), status: 404 },
      { path: "/hidden", html: html(HARD, 16), noindex: true },
    ];
    const check = await bothPaths(specs);
    expect(check.status).toBe("pass");
    expect(check.details).toMatchObject({ skippedNoindexPages: 1 });
  });

  test("a row stored without a reading level is not a sample", async () => {
    const ctx = streamCtx(normals(14));
    const rule = voiceConsistencyRule.run(ctx) as Promise<{ checks: CheckResult[] }>;
    expect((await rule).checks[0]?.status).toBe("pass");
  });

  test("legacy path with no pages skips", async () => {
    const ctx = legacyCtx([]);
    expect((await run(ctx))[0]?.status).toBe("skipped");
  });
});
