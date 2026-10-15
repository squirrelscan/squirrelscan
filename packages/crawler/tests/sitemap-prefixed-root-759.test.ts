// #759: a sitemap whose elements carry a prefix bound to the sitemap
// namespace (`<ns0:urlset xmlns:ns0="…/sitemap/0.9">`, as Python's
// ElementTree writes one) is valid XML in the sitemap namespace. It used to
// read as `Unknown sitemap format`, with none of its URLs.

import { describe, expect, test } from "bun:test";

import { decodeSitemapBody, parseSitemap } from "../src/sitemaps";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const URL_ = "https://example.com/sitemap.xml";

describe("a sitemap with a namespace-prefixed root (#759)", () => {
  test("a prefixed urlset reads like the unprefixed form", () => {
    const prefixed = `<?xml version="1.0" encoding="UTF-8"?>
<ns0:urlset xmlns:ns0="${NS}">
  <ns0:url>
    <ns0:loc>https://example.com/a</ns0:loc>
    <ns0:lastmod>2024-09-10</ns0:lastmod>
    <ns0:changefreq>weekly</ns0:changefreq>
    <ns0:priority>0.8</ns0:priority>
  </ns0:url>
  <ns0:url><ns0:loc>https://example.com/b?x=1&amp;y=2</ns0:loc></ns0:url>
</ns0:urlset>`;
    const plain = prefixed.replaceAll("ns0:", "").replace(`xmlns:ns0=`, "xmlns=");
    const result = parseSitemap(prefixed, URL_);
    expect(result.errors).toEqual([]);
    expect(result.type).toBe("urlset");
    expect(result.urls).toEqual([
      { loc: "https://example.com/a", lastmod: "2024-09-10", changefreq: "weekly", priority: 0.8 },
      { loc: "https://example.com/b?x=1&y=2", lastmod: undefined, changefreq: undefined, priority: undefined },
    ]);
    expect(result).toEqual({ ...parseSitemap(plain, URL_), isNewsSitemap: false });
  });

  test("a prefixed sitemap index lists its child sitemaps", () => {
    const result = parseSitemap(
      `<sm:sitemapindex xmlns:sm="${NS}">
        <sm:sitemap><sm:loc>https://example.com/s1.xml</sm:loc><sm:lastmod>2024</sm:lastmod></sm:sitemap>
        <sm:sitemap><sm:loc>https://example.com/s2.xml</sm:loc></sm:sitemap>
      </sm:sitemapindex>`,
      URL_,
    );
    expect(result).toMatchObject({
      type: "index",
      childSitemaps: ["https://example.com/s1.xml", "https://example.com/s2.xml"],
      errors: [],
    });
  });

  test("a news sitemap with a prefixed root is still recognised as news", () => {
    const result = parseSitemap(
      `<ns0:urlset xmlns:ns0="${NS}" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <ns0:url><ns0:loc>https://example.com/story</ns0:loc></ns0:url>
      </ns0:urlset>`,
      URL_,
    );
    expect(result.isNewsSitemap).toBe(true);
    expect(result.urls.map((u) => u.loc)).toEqual(["https://example.com/story"]);
  });

  test("a root in another namespace is still an unknown format, whatever its prefix", () => {
    for (const root of [
      `<x:urlset xmlns:x="http://example.com/not-sitemaps"><x:url><x:loc>https://example.com/a</x:loc></x:url></x:urlset>`,
      `<ns0:urlset><ns0:url><ns0:loc>https://example.com/a</ns0:loc></ns0:url></ns0:urlset>`,
      `<ns0:sitemapindex xmlns:ns0="urn:other"><ns0:sitemap><ns0:loc>https://example.com/s.xml</ns0:loc></ns0:sitemap></ns0:sitemapindex>`,
    ]) {
      expect(parseSitemap(root, URL_).errors).toEqual(["Unknown sitemap format"]);
    }
  });

  test("the fetched body path reads a prefixed sitemap too", () => {
    const body = new TextEncoder().encode(
      `<?xml version="1.0"?><ns0:urlset xmlns:ns0="${NS}"><ns0:url><ns0:loc>https://example.com/a</ns0:loc></ns0:url></ns0:urlset>`,
    );
    const decoded = decodeSitemapBody(body, URL_, "application/xml");
    expect(decoded.data.errors).toEqual([]);
    expect(decoded.data.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
  });

  test("every sitemap namespace it accepts reads, in either scheme and Google's older ones", () => {
    for (const ns of [
      "https://www.sitemaps.org/schemas/sitemap/0.9",
      "http://www.google.com/schemas/sitemap/0.84",
      "http://www.google.com/schemas/sitemap/0.9",
    ]) {
      const result = parseSitemap(
        `<p:urlset xmlns:p="${ns}"><p:url><p:loc>https://example.com/a</p:loc></p:url></p:urlset>`,
        URL_,
      );
      expect(result.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
    }
  });

  test("a prefixed __proto__ element is refused like the unprefixed one", () => {
    const evil = (name: string) =>
      `<ns0:urlset xmlns:ns0="${NS}"><${name}><ns0:url><ns0:loc>https://e.com/evil</ns0:loc></ns0:url></${name}></ns0:urlset>`;
    expect(parseSitemap(evil("ns0:__proto__"), URL_).urls).toEqual([]);
    expect(parseSitemap(evil("ns0:__proto__"), URL_).errors[0]).toContain("Invalid name");
  });

  test("an element written both prefixed and not is a repeat, flagged as one", () => {
    const result = parseSitemap(
      `<ns0:urlset xmlns:ns0="${NS}" xmlns="${NS}"><ns0:url><ns0:loc>https://example.com/a</ns0:loc><loc>https://example.com/b</loc></ns0:url><ns0:url><ns0:loc>https://example.com/c</ns0:loc></ns0:url><url><loc>https://example.com/d</loc></url></ns0:urlset>`,
      URL_,
    );
    expect(result.urls.map((u) => u.loc)).toEqual(["https://example.com/c", "https://example.com/d"]);
    expect(result.errors.join(" ")).toContain("skipped");
  });

  test("an unprefixed root is read as before when a prefixed one sits beside it", () => {
    const result = parseSitemap(
      `<urlset xmlns="${NS}"><url><loc>https://example.com/a</loc></url></urlset><x:sitemapindex xmlns:x="${NS}"><x:sitemap><x:loc>https://example.com/s.xml</x:loc></x:sitemap></x:sitemapindex>`,
      URL_,
    );
    expect(result.type).toBe("urlset");
    expect(result.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
  });

  test("a root prefixed news: and bound to the sitemap namespace is not a news sitemap", () => {
    const result = parseSitemap(
      `<news:urlset xmlns:news="${NS}"><news:url><news:loc>https://example.com/a</news:loc></news:url></news:urlset>`,
      URL_,
    );
    expect(result.isNewsSitemap).toBe(false);
    expect(result.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
  });
});
