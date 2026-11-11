// content/duplicate-content (#1690): groups of indexable pages with identical body text
// that do not resolve to one canonical. Every case runs through BOTH paths (legacy
// ctx.site.pages and streaming collectedSignals + siteQuery) and asserts identical output.

import { describe, expect, test } from "bun:test";

import type { CheckResult, PageFeatureRow, SiteQuery } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import {
  buildContentFingerprint,
  duplicateContentRule,
  fingerprintForPage,
  isPaginatedUrl,
  MAX_GROUPS,
  MAX_URLS_PER_GROUP,
  MIN_WORDS,
  TRACKING_PARAMS,
  urlFormKey,
} from "../src/content/duplicate-content";
import { noindexSource } from "../src/shared/noindex";
import type { RuleContext } from "../src/types";

const words = (n: number, tag = "alpha") =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const BODY = words(150);

interface Spec {
  url: string;
  body?: string;
  title?: string;
  status?: number;
  noindex?: boolean;
  canonical?: string;
  alternates?: { hreflang: string; href: string }[];
  finalUrl?: string;
}

function html(s: Spec): string {
  const links = [
    s.canonical ? `<link rel="canonical" href="${s.canonical}">` : "",
    ...(s.alternates ?? []).map(
      (a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}">`,
    ),
    s.noindex ? `<meta name="robots" content="noindex">` : "",
  ].join("");
  return `<!doctype html><html><head><title>${s.title ?? s.url}</title>${links}</head><body><main><p>${s.body ?? BODY}</p></main></body></html>`;
}

const baseCtx = {
  page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
  parsed: {} as never,
  options: {},
};

function legacyCtx(specs: Spec[]): RuleContext {
  return {
    ...baseCtx,
    site: {
      baseUrl: "https://example.com/",
      pages: specs.map((s) => ({
        url: s.url,
        ...(s.finalUrl ? { finalUrl: s.finalUrl } : {}),
        statusCode: s.status ?? 200,
        parsed: parsePage(html(s), s.url),
      })),
      robotsTxt: null,
      sitemaps: null,
    },
  };
}

function row(s: Spec): PageFeatureRow {
  const parsed = parsePage(html(s), s.url);
  return {
    normalizedUrl: s.url,
    status: s.status ?? 200,
    robotsNoindex: noindexSource(parsed, undefined) !== null,
    canonical: parsed.meta.canonical ?? null,
    hreflangAlternates: parsed.hreflangAlternates ?? null,
  } as unknown as PageFeatureRow;
}

function streamingCtx(specs: Spec[], opts: { withoutFingerprint?: boolean } = {}): RuleContext {
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
  return {
    ...baseCtx,
    site: { baseUrl: "https://example.com/", pages: [], robotsTxt: null, sitemaps: null },
    siteQuery,
    collectedSignals: {
      pages: specs.map((s) => {
        const parsed = parsePage(html(s), s.url);
        return {
          url: s.url,
          ...(opts.withoutFingerprint
            ? {}
            : { contentFingerprint: fingerprintForPage(parsed.document, s.url, s.finalUrl) }),
        } as never;
      }),
    },
  };
}

async function check(ctx: RuleContext): Promise<CheckResult> {
  const out = await Promise.resolve(duplicateContentRule.run(ctx));
  expect(out.checks).toHaveLength(1);
  return out.checks[0]!;
}

/** Both paths, asserted identical. */
async function both(specs: Spec[]): Promise<CheckResult> {
  const legacy = await check(legacyCtx(specs));
  const streaming = await check(streamingCtx(specs));
  expect(streaming).toEqual(legacy);
  return legacy;
}

const u = (p: string) => `https://example.com${p}`;

describe("content/duplicate-content", () => {
  test("AC1: same body, different canonicals: one group listing every URL", async () => {
    const r = await both([
      { url: u("/a"), title: "A", canonical: u("/a") },
      { url: u("/b"), title: "B", canonical: u("/b") },
      { url: u("/c"), title: "C" },
    ]);
    expect(r.status).toBe("warn");
    expect(r.message).toBe("1 duplicate content group(s) found across 3 pages");
    expect(r.items).toHaveLength(1);
    expect(r.items![0]!.sourcePages).toEqual([u("/a"), u("/b"), u("/c")]);
  });

  test("AC2: every page declares the same canonical: not reported", async () => {
    const r = await both([
      { url: u("/a"), canonical: u("/a") },
      { url: u("/b"), canonical: u("/a") },
      { url: u("/c"), canonical: u("/a") },
    ]);
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ canonicalisedGroups: 1 });
  });

  test("a relative canonical resolves against the page URL", async () => {
    const r = await both([
      { url: u("/a"), canonical: "/a" },
      { url: u("/b"), canonical: "/a" },
    ]);
    expect(r.status).toBe("pass");
  });

  test("AC3: noindex, redirect and error pages are left out and counted", async () => {
    const r = await both([
      { url: u("/a") },
      { url: u("/b") },
      { url: u("/noindex"), noindex: true },
      { url: u("/gone"), status: 404 },
      { url: u("/moved"), status: 301 },
    ]);
    expect(r.status).toBe("warn");
    expect(r.items![0]!.sourcePages).toEqual([u("/a"), u("/b")]);
    expect(r.details).toMatchObject({ excluded: { noindex: 1, notOk: 2 } });
  });

  test("AC3: a page that redirected to another URL has no fingerprint", async () => {
    const r = await both([
      { url: u("/a") },
      { url: u("/b") },
      { url: u("/old"), finalUrl: u("/b") },
    ]);
    expect(r.items![0]!.sourcePages).toEqual([u("/a"), u("/b")]);
  });

  test("a group reduced to one page by exclusions passes", async () => {
    const r = await both([
      { url: u("/a") },
      { url: u("/b"), noindex: true },
      { url: u("/c"), body: words(150, "other") },
    ]);
    expect(r.status).toBe("pass");
  });

  test("AC4: pagination pages are left out and counted", async () => {
    const r = await both([
      { url: u("/list") },
      { url: u("/list?page=2") },
      { url: u("/list/page/3/") },
      { url: u("/other") },
    ]);
    expect(r.items![0]!.sourcePages).toEqual([u("/list"), u("/other")]);
    expect(r.details).toMatchObject({ excluded: { pagination: 2 } });
  });

  test("AC4: reciprocal hreflang alternates are not duplicates of each other", async () => {
    const alt = (a: string, b: string, l: string) => ({ hreflang: l, href: u(b) });
    const r = await both([
      { url: u("/en"), alternates: [alt("", "/en", "en"), alt("", "/de", "de")] },
      { url: u("/de"), alternates: [alt("", "/en", "en"), alt("", "/de", "de")] },
    ]);
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ excluded: { hreflang: 2 } });
  });

  test("AC4: a one-way hreflang reference does not hide a duplicate", async () => {
    const r = await both([
      { url: u("/en"), alternates: [{ hreflang: "de", href: u("/de") }] },
      { url: u("/de") },
    ]);
    expect(r.status).toBe("warn");
  });

  test("AC4: an unrelated page keeps the group reported with every URL", async () => {
    const pair = [
      { hreflang: "en", href: u("/en") },
      { hreflang: "de", href: u("/de") },
    ];
    const r = await both([
      { url: u("/en"), alternates: pair },
      { url: u("/de"), alternates: pair },
      { url: u("/copy") },
    ]);
    expect(r.items![0]!.sourcePages).toEqual([u("/copy"), u("/de"), u("/en")]);
  });

  test("AC5: pages below the minimum word count are left out", async () => {
    const thin = words(MIN_WORDS - 1);
    const r = await both([
      { url: u("/a"), body: thin },
      { url: u("/b"), body: thin },
      { url: u("/c") },
      { url: u("/d") },
    ]);
    expect(r.items![0]!.sourcePages).toEqual([u("/c"), u("/d")]);
    expect(r.details).toMatchObject({ excluded: { thin: 2 }, minWords: 100 });
    const exact = await both([
      { url: u("/a"), body: words(MIN_WORDS) },
      { url: u("/b"), body: words(MIN_WORDS) },
    ]);
    expect(exact.status).toBe("warn");
  });

  test("AC6: groups ordered largest first, message counts groups and pages", async () => {
    const g2 = words(150, "two");
    const g3 = words(150, "three");
    const r = await both([
      { url: u("/p1"), body: g2 },
      { url: u("/p2"), body: g2 },
      { url: u("/a1"), body: g3 },
      { url: u("/a2"), body: g3 },
      { url: u("/a3"), body: g3 },
    ]);
    expect(r.message).toBe("2 duplicate content group(s) found across 5 pages");
    expect(r.items!.map((i) => i.meta!.pageCount)).toEqual([3, 2]);
    expect(r.details).toMatchObject({ totalGroups: 2, totalPages: 5 });
  });

  test("AC7: URLs that differ only by URL form carry the note", async () => {
    const r = await both([
      { url: u("/page") },
      { url: u("/page/") },
      { url: u("/Page") },
      { url: u("/page?utm_source=x&gclid=1") },
    ]);
    const item = r.items![0]!;
    expect(item.meta).toMatchObject({ urlFormOnly: true });
    expect(item.label).toContain(
      "URL form (tracking parameters, trailing slash or letter case) is the cause",
    );
    expect(r.details).toMatchObject({ urlFormGroups: 1 });
  });

  test("a group of genuinely different URLs has no URL-form note", async () => {
    const r = await both([{ url: u("/a") }, { url: u("/b") }]);
    expect(r.items![0]!.meta).toMatchObject({ urlFormOnly: false });
    expect(r.items![0]!.label).not.toContain("URL form");
  });

  test("AC8: no duplicate groups passes", async () => {
    const r = await both([
      { url: u("/a"), body: words(150, "x") },
      { url: u("/b"), body: words(150, "y") },
    ]);
    expect(r.status).toBe("pass");
    expect(r.message).toBe("No pages share identical body content");
  });

  test("different titles with the same body are still found", async () => {
    const r = await both([
      { url: u("/a"), title: "One" },
      { url: u("/b"), title: "Two" },
    ]);
    expect(r.status).toBe("warn");
  });

  test("whitespace and case differences do not change the fingerprint", () => {
    const fp = (b: string) =>
      buildContentFingerprint(parsePage(`<html><body><p>${b}</p></body></html>`, u("/")).document!);
    expect(fp("Hello   World\n foo")).toEqual(fp("hello world foo"));
    expect(fp("hello world foo")!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(fp("hello world foo")).not.toEqual(fp("hello world bar"));
  });

  test("AC9: shuffled input gives the same output", async () => {
    const specs: Spec[] = [
      ...Array.from({ length: 6 }, (_, i) => ({ url: u(`/x${i}`), body: words(150, "x") })),
      ...Array.from({ length: 4 }, (_, i) => ({ url: u(`/y${i}`), body: words(150, "y") })),
      ...Array.from({ length: 4 }, (_, i) => ({ url: u(`/z${i}`), body: words(150, "z") })),
    ];
    const base = await both(specs);
    for (const order of [
      [...specs].reverse(),
      [...specs].sort((a, b) => (a.url < b.url ? 1 : -1)),
    ]) {
      expect(await both(order)).toEqual(base);
    }
  });

  test("caps listed URLs and groups, keeping the totals", async () => {
    const many = Array.from({ length: MAX_URLS_PER_GROUP + 5 }, (_, i) => ({
      url: u(`/m${String(i).padStart(3, "0")}`),
      body: words(150, "m"),
    }));
    const r = await both(many);
    expect(r.items![0]!.sourcePages).toHaveLength(MAX_URLS_PER_GROUP);
    expect(r.items![0]!.meta).toMatchObject({ pageCount: MAX_URLS_PER_GROUP + 5, omittedUrls: 5 });

    const groups: Spec[] = [];
    for (let g = 0; g < MAX_GROUPS + 2; g++) {
      const body = words(120, `g${g}x`);
      groups.push({ url: u(`/g${g}/a`), body }, { url: u(`/g${g}/b`), body });
    }
    const r2 = await both(groups);
    expect(r2.items).toHaveLength(MAX_GROUPS);
    expect(r2.details).toMatchObject({ totalGroups: MAX_GROUPS + 2, omittedGroups: 2 });
  }, 20_000);

  test("skips with fewer than two candidate pages, and with no fingerprint data", async () => {
    expect((await both([{ url: u("/a") }])).status).toBe("skipped");
    expect((await both([])).status).toBe("skipped");
    const ctx = streamingCtx([{ url: u("/a") }, { url: u("/b") }], { withoutFingerprint: true });
    expect((await check(ctx)).status).toBe("skipped");
    const noDocs = legacyCtx([{ url: u("/a") }, { url: u("/b") }]);
    for (const p of noDocs.site.pages) (p.parsed as { document: unknown }).document = undefined;
    expect((await check(noDocs)).status).toBe("skipped");
  });

  test("a document without a body fingerprints to null", () => {
    const throwing = {
      get body(): never {
        throw new Error("no root element");
      },
    } as unknown as Document;
    expect(buildContentFingerprint(throwing)).toBeNull();
    expect(buildContentFingerprint({ body: null } as unknown as Document)).toBeNull();
  });

  test("helpers", () => {
    expect(isPaginatedUrl(u("/a?Page=2"))).toBe(true);
    expect(isPaginatedUrl(u("/a/page/2"))).toBe(true);
    expect(isPaginatedUrl(u("/a/page/x"))).toBe(false);
    expect(isPaginatedUrl(u("/pages/2"))).toBe(false);
    expect([...TRACKING_PARAMS]).toEqual([...TRACKING_PARAMS].sort());
    expect(urlFormKey(u("/A/?ref=1&q=2"))).toBe(urlFormKey(u("/a?q=2")));
    expect(urlFormKey(u("/a?q=2"))).not.toBe(urlFormKey(u("/a?q=3")));
  });
});
