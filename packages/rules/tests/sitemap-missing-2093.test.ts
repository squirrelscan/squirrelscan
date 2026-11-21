// images/sitemap-missing (pub#2093): main image absent from the page's sitemap image entries.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SitemapDiscovery, SitemapUrl } from "@squirrelscan/core-contracts";
import { parsePage } from "@squirrelscan/parser";

import { normalizeImageUrl, sitemapMissingRule } from "../src/images/sitemap-missing";
import type { ParsedPage, RuleContext } from "../src/types";
import { expectDeclaredChecks } from "./helpers/declared-checks";

const PAGE = "https://shop.example.com/products/mug";

function discovery(urls: SitemapUrl[]): SitemapDiscovery {
  return {
    discovered: [{ url: "https://shop.example.com/sitemap.xml", type: "urlset", urls, childSitemaps: [], errors: [], urlCount: urls.length }],
  } as unknown as SitemapDiscovery;
}

function run(
  head: string,
  urls: SitemapUrl[],
  opts: { status?: number; headers?: Record<string, string>; url?: string } = {},
): CheckResult[] {
  const url = opts.url ?? PAGE;
  const html = `<!doctype html><html lang="en"><head><title>t</title>${head}</head><body></body></html>`;
  const out = sitemapMissingRule.run({
    page: { url, html, statusCode: opts.status ?? 200, loadTime: 0, headers: opts.headers ?? {} },
    parsed: parsePage(html, url) as ParsedPage,
    site: { baseUrl: "https://shop.example.com", pages: [], robotsTxt: null, sitemaps: discovery(urls) },
    options: {},
  } as unknown as RuleContext);
  if (out instanceof Promise) throw new Error("sync rule");
  expectDeclaredChecks(sitemapMissingRule, out.checks);
  return out.checks;
}

const og = (u: string) => `<meta property="og:image" content="${u}">`;
const status = (checks: CheckResult[]) => checks[0]?.status;
const OTHER: SitemapUrl = { loc: "https://shop.example.com/products/other", images: ["https://cdn.shopify.com/s/files/1/p/other.jpg"] };

describe("images/sitemap-missing", () => {
  test("flags an indexable page whose og:image is not in its entries", () => {
    const checks = run(og("https://cdn.shopify.com/s/files/1/p/mug.jpg"), [
      { loc: PAGE, images: ["https://cdn.shopify.com/s/files/1/p/other-photo.jpg"] },
      OTHER,
    ]);
    expect(status(checks)).toBe("info");
  });

  test("not judged: a page listed with no image entries of its own while others have them (Shopify homepage, /pages/*)", () => {
    expect(run(og("https://cdn.example.com/mug.jpg"), [{ loc: PAGE }, OTHER])).toEqual([]);
  });

  test("a stock Shopify product passes: storefront /cdn/shop og:image matches the cdn.shopify.com sitemap entry", () => {
    const checks = run(og("http://shop.example.com/cdn/shop/files/mug.png?v=1700000000&width=1200"), [
      { loc: PAGE, images: ["https://cdn.shopify.com/s/files/1/0123/4567/8901/files/mug.png?v=1700000000"] },
      OTHER,
    ]);
    expect(status(checks)).toBe("pass");
    const miss = run(og("http://shop.example.com/cdn/shop/files/cup.png?v=1"), [
      { loc: PAGE, images: ["https://cdn.shopify.com/s/files/1/0123/4567/8901/files/mug.png?v=1"] },
      OTHER,
    ]);
    expect(status(miss)).toBe("info");
  });

  test("a stock Shopify sitemap passes: size suffix, query string and protocol-relative og:image normalize", () => {
    const checks = run(og("//cdn.shopify.com/s/files/1/p/mug_1200x630.jpg?v=1700000000"), [
      { loc: PAGE, images: ["https://cdn.shopify.com/s/files/1/p/mug.jpg?v=1700000000"] },
      OTHER,
    ]);
    expect(status(checks)).toBe("pass");
  });

  test("a Product JSON-LD image (ImageObject or list) counts as a main image", () => {
    const ld = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      image: [{ "@type": "ImageObject", url: "https://cdn.example.com/mug_800x.jpg" }],
    })}</script>`;
    expect(status(run(ld, [{ loc: PAGE, images: ["https://cdn.example.com/mug.jpg"] }, OTHER]))).toBe("pass");
    expect(status(run(ld, [{ loc: PAGE, images: ["https://cdn.example.com/x.jpg"] }, OTHER]))).toBe("info");
  });

  test("not flagged: no main image, non-200, noindex (meta and header), foreign canonical, page not in sitemap, truncated entry", () => {
    const urls = [{ loc: PAGE, images: ["https://cdn.example.com/x.jpg"] }, OTHER];
    const miss = og("https://cdn.example.com/mug.jpg");
    expect(run("", urls)).toEqual([]);
    expect(run(miss, urls, { status: 404 })).toEqual([]);
    expect(run(miss + '<meta name="robots" content="noindex">', urls)).toEqual([]);
    expect(run(miss, urls, { headers: { "x-robots-tag": "noindex" } })).toEqual([]);
    expect(run(miss + '<link rel="canonical" href="https://shop.example.com/products/other">', urls)).toEqual([]);
    expect(run(miss, [OTHER])).toEqual([]);
    expect(run(miss, [{ ...urls[0]!, imagesTruncated: true }, OTHER])).toEqual([]);
  });

  test("a self canonical does not stop the check", () => {
    const head = og("https://cdn.example.com/mug.jpg") + `<link rel="canonical" href="${PAGE}/">`;
    expect(status(run(head, [{ loc: PAGE, images: ["https://cdn.example.com/x.jpg"] }, OTHER]))).toBe("info");
  });

  test("a site with no image entries anywhere is skipped, never flagged", () => {
    const checks = run(og("https://cdn.example.com/mug.jpg"), [{ loc: PAGE }, { loc: "https://shop.example.com/" }]);
    expect(status(checks)).toBe("skipped");
  });

  test("no sitemap data is skipped", () => {
    const html = "<html><head></head><body></body></html>";
    const out = sitemapMissingRule.run({
      page: { url: PAGE, html, statusCode: 200, loadTime: 0, headers: {} },
      parsed: parsePage(html, PAGE) as ParsedPage,
      site: { baseUrl: "https://shop.example.com", pages: [], robotsTxt: null, sitemaps: null },
      options: {},
    } as unknown as RuleContext);
    expect((out as { checks: CheckResult[] }).checks.map((c) => c.status)).toEqual(["skipped"]);
  });

  test("normalizeImageUrl strips size suffixes, query, fragment and scheme", () => {
    const base = "https://a.com/";
    const n = (u: string) => normalizeImageUrl(u, base);
    expect(n("https://CDN.a.com/p/x_800x.jpg?v=3#f")).toBe(n("http://cdn.a.com/p/x.jpg"));
    expect(n("/p/x-300x200.png")).toBe(n("https://a.com/p/x.png"));
    expect(n("data:image/png;base64,AAA")).toBeNull();
    expect(n("//shop.a.com/cdn/shop/products/x_1200x.jpg?v=1")).toBe(
      n("https://cdn.shopify.com/s/files/1/0123/4567/products/x.jpg?v=1"),
    );
    expect(n("https://other.com/s/files/1/0123/products/x.jpg")).not.toBe(n("https://shop.a.com/cdn/shop/products/x.jpg"));
  });
});
