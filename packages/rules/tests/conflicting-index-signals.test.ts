// crawl/conflicting-index-signals: one finding per page that is in the sitemap and also carries two or more
// "do not index" signals (#1771). A single mismatch stays with the existing rule that covers it.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";
import { parseRobotsTxt } from "@squirrelscan/utils/robots-txt";

import { conflictingIndexSignalsRule, evaluateIndexSignals, sitemapUrlSet } from "../src/crawl/conflicting-index-signals";
import { noindexInSitemapRule } from "../src/crawl/noindex-in-sitemap";
import type { ParsedPage, RuleContext } from "../src/types";

const BASE = "https://example.com";
const NOINDEX = '<meta name="robots" content="noindex">';
const ROBOTS = parseRobotsTxt("User-agent: *\nDisallow: /private/\n", `${BASE}/robots.txt`);

interface Spec {
  path: string;
  noindex?: boolean;
  header?: boolean;
  canonical?: string;
  inSitemap?: boolean;
}

function build(specs: Spec[], robots = ROBOTS) {
  const pages = specs.map((s) => {
    const url = `${BASE}${s.path}`;
    const head = `<title>t</title>${s.noindex ? NOINDEX : ""}${s.canonical ? `<link rel="canonical" href="${s.canonical}">` : ""}`;
    const html = `<!doctype html><html lang="en"><head>${head}</head><body><h1>t</h1></body></html>`;
    return {
      url,
      statusCode: 200,
      headers: s.header ? { "x-robots-tag": "noindex" } : {},
      parsed: parsePage(html, url) as ParsedPage,
    };
  });
  const urls = specs.filter((s) => s.inSitemap).map((s) => ({ loc: `${BASE}${s.path}` }));
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages,
      robotsTxt: robots,
      sitemaps: { discovered: [{ url: `${BASE}/sitemap.xml`, urls }] },
    },
    options: {},
  } as unknown as RuleContext;
}

async function run(specs: Spec[]): Promise<CheckResult> {
  const { checks } = await Promise.resolve(conflictingIndexSignalsRule.run(build(specs)));
  return (checks as CheckResult[])[0]!;
}

const filler = (n: number): Spec[] =>
  Array.from({ length: n }, (_, i) => ({ path: `/ok-${i}`, inSitemap: true }));

describe("crawl/conflicting-index-signals (#1771)", () => {
  test("noindex + canonical elsewhere + sitemap: one finding listing the three signals and the URLs", async () => {
    const check = await run([
      ...filler(4),
      { path: "/p/x", noindex: true, canonical: `${BASE}/`, inSitemap: true },
    ]);
    expect(check.status).toBe("warn");
    expect(check.pages).toEqual([`${BASE}/p/x`]);
    const item = check.items![0]!;
    expect(item.id).toBe(`${BASE}/p/x`);
    expect(item.label).toContain("listed in the sitemap");
    expect(item.label).toContain("noindex in the robots meta tag");
    expect(item.label).toContain(`canonical points to a different URL (${BASE}/)`);
    expect(check.message).toContain("Decide whether each page should be indexed");
    expect(check.message).toContain("To keep it out of search");
    expect(check.message).toContain("To put it in search");
    expect(check.details?.relatedRules).toContain("crawl/noindex-in-sitemap");
    expect(check.details?.relatedRules).toContain("core/canonical");
  });

  test("noindex + sitemap only (the existing rule's case) is not reported", async () => {
    const check = await run([...filler(4), { path: "/p/x", noindex: true, inSitemap: true }]);
    expect(check.status).toBe("pass");
  });

  test("canonical elsewhere + sitemap only is not reported", async () => {
    const check = await run([
      ...filler(4),
      { path: "/p/x", canonical: `${BASE}/other`, inSitemap: true },
    ]);
    expect(check.status).toBe("pass");
  });

  test("a consistent noindex page (noindex + canonical elsewhere, not in the sitemap) is not reported", async () => {
    const check = await run([...filler(4), { path: "/p/x", noindex: true, canonical: `${BASE}/` }]);
    expect(check.status).toBe("pass");
  });

  test("a consistent indexable page (self canonical, in the sitemap) is not reported", async () => {
    const check = await run([
      ...filler(3),
      { path: "/p/x", canonical: `${BASE}/p/x/#top`, inSitemap: true },
    ]);
    expect(check.status).toBe("pass");
  });

  test("header noindex plus a robots.txt block plus the sitemap counts", async () => {
    const check = await run([...filler(4), { path: "/private/a", header: true, inSitemap: true }]);
    expect(check.status).toBe("warn");
    expect(check.items![0]!.label).toContain("X-Robots-Tag");
    expect(check.items![0]!.label).toContain("blocked by robots.txt");
  });

  test("a site-wide noindex is reported once, not once per page", async () => {
    const all = Array.from({ length: 6 }, (_, i) => ({
      path: `/s-${i}`,
      noindex: true,
      canonical: `${BASE}/`,
      inSitemap: true,
    }));
    const { checks } = await Promise.resolve(conflictingIndexSignalsRule.run(build(all)));
    expect(checks).toHaveLength(1);
    const check = (checks as CheckResult[])[0]!;
    expect(check.name).toBe("site-wide-noindex");
    expect(check.status).toBe("info");
    expect(check.items).toBeUndefined();
  });

  test("no sitemap: skipped", async () => {
    const ctx = build([{ path: "/a", noindex: true }]);
    (ctx.site as { sitemaps: unknown }).sitemaps = { discovered: [] };
    const { checks } = await Promise.resolve(conflictingIndexSignalsRule.run(ctx));
    expect((checks as CheckResult[])[0]!.status).toBe("skipped");
  });

  test("crawl/noindex-in-sitemap keeps its finding and points at the combined one", async () => {
    const ctx = build([
      ...filler(4),
      { path: "/p/x", noindex: true, canonical: `${BASE}/`, inSitemap: true },
      { path: "/p/y", noindex: true, inSitemap: true },
    ]);
    const { checks } = await Promise.resolve(noindexInSitemapRule.run(ctx));
    const check = (checks as CheckResult[])[0]!;
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(2);
    expect(check.details?.alsoReportedBy).toBe("crawl/conflicting-index-signals");
    expect(check.details?.alsoReportedPages).toEqual([`${BASE}/p/x`]);
  });
});

describe("the sitemap is matched on normalized URLs (both engines share this)", () => {
  test("a sitemap entry with a trailing slash, a fragment or a different slash form still matches the page", () => {
    const sitemaps = {
      discovered: [{ url: "https://x.test/sitemap.xml", type: "urlset", urls: [{ loc: "https://x.test/a/" }, { loc: "https://x.test/b#top" }] }],
    } as never;
    const urls = sitemapUrlSet(sitemaps);
    const page = (url: string) => ({
      url,
      status: 200,
      canonical: "https://x.test/elsewhere",
      reasons: ["meta:noindex"],
    });
    for (const url of ["https://x.test/a", "https://x.test/b"]) {
      const verdict = evaluateIndexSignals([page(url)], urls, null);
      expect(verdict.kind).toBe("conflicts");
    }
    expect(evaluateIndexSignals([page("https://x.test/c")], urls, null).kind).toBe("none");
  });
});

