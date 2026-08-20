// A Google News sitemap holds only ~48 hours of articles by specification, so its lastmod values
// always collapse onto one or two days. Rules that pool lastmod across sitemaps have to exclude them,
// and the only sound signal is the namespace declaration: `google-news-sitemap.xml` is a widespread
// convention, not part of any spec, and a news sitemap can be served from any path.
import { describe, expect, test } from "bun:test";

import { parseSitemap } from "../src/sitemaps";

const NEWS_NS = "http://www.google.com/schemas/sitemap-news/0.9";

function urlset(attrs: string, body = "<url><loc>https://example.com/a</loc></url>"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${attrs}>${body}</urlset>`;
}

describe("news-sitemap detection", () => {
  test("xmlns:news marks the sitemap as a news sitemap", () => {
    const data = parseSitemap(urlset(` xmlns:news="${NEWS_NS}"`), "https://example.com/sitemap.xml");
    expect(data.isNewsSitemap).toBe(true);
  });

  test("an ordinary sitemap is not a news sitemap", () => {
    expect(parseSitemap(urlset(""), "https://example.com/sitemap.xml").isNewsSitemap).toBe(false);
  });

  /** The filename is not the signal, in either direction. */
  test("a news-shaped filename without the namespace is still not a news sitemap", () => {
    const data = parseSitemap(urlset(""), "https://example.com/google-news-sitemap.xml");
    expect(data.isNewsSitemap).toBe(false);
  });

  test("the namespace counts wherever the sitemap is served from", () => {
    const data = parseSitemap(urlset(` xmlns:news="${NEWS_NS}"`), "https://example.com/feeds/2.xml");
    expect(data.isNewsSitemap).toBe(true);
  });

  test("a real news entry parses normally and keeps its lastmod", () => {
    const data = parseSitemap(
      urlset(
        ` xmlns:news="${NEWS_NS}"`,
        `<url><loc>https://example.com/story</loc><lastmod>2026-08-19T04:00:00Z</lastmod>` +
          `<news:news><news:publication><news:name>Example</news:name>` +
          `<news:language>en</news:language></news:publication>` +
          `<news:publication_date>2026-08-19T04:00:00Z</news:publication_date>` +
          `<news:title>Story</news:title></news:news></url>`,
      ),
      "https://example.com/news.xml",
    );
    expect(data.isNewsSitemap).toBe(true);
    expect(data.urls).toHaveLength(1);
    expect(data.urls[0]?.lastmod).toBe("2026-08-19T04:00:00Z");
  });

  /** A sitemap INDEX has no urls to pool, so the flag is only meaningful on a urlset. */
  test("an index is not marked, and still yields its children", () => {
    const data = parseSitemap(
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/news.xml</loc></sitemap></sitemapindex>`,
      "https://example.com/sitemap.xml",
    );
    expect(data.type).toBe("index");
    expect(data.isNewsSitemap).toBeFalsy();
    expect(data.childSitemaps).toEqual(["https://example.com/news.xml"]);
  });
});
