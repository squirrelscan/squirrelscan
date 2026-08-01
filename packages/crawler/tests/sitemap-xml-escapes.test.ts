// The parser runs with processEntities:false to block declared-entity
// substitution. That also suppresses the five XML predefined escapes, which
// are the spec-mandated way to encode `&` in a sitemap URL — so they must be
// decoded after parsing, or a `?q=1&amp;page=2` loc gets fetched literally and
// we crawl a different URL than the sitemap advertised.
import { describe, expect, test } from "bun:test";

import { parseSitemap } from "../src/sitemaps";

function urlset(...locs: string[]): string {
  const entries = locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

describe("sitemap predefined XML escapes", () => {
  test("decodes &amp; in a query string", () => {
    const data = parseSitemap(
      urlset("https://example.com/search?q=1&amp;page=2"),
      "https://example.com/sitemap.xml",
    );
    expect(data.urls.map((u) => u.loc)).toEqual(["https://example.com/search?q=1&page=2"]);
  });

  test("decodes the remaining four predefined escapes", () => {
    const data = parseSitemap(
      urlset("https://example.com/a?x=&lt;&gt;&quot;&apos;"),
      "https://example.com/sitemap.xml",
    );
    expect(data.urls[0]?.loc).toBe("https://example.com/a?x=<>\"'");
  });

  test("does not double-decode: &amp;lt; yields the literal &lt;", () => {
    const data = parseSitemap(
      urlset("https://example.com/a?x=&amp;lt;"),
      "https://example.com/sitemap.xml",
    );
    expect(data.urls[0]?.loc).toBe("https://example.com/a?x=&lt;");
  });

  test("decodes escapes in sitemap index child locs", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      `<sitemap><loc>https://example.com/sitemap.xml?shard=1&amp;v=2</loc></sitemap></sitemapindex>`;
    const data = parseSitemap(xml, "https://example.com/sitemap-index.xml");
    expect(data.childSitemaps).toEqual(["https://example.com/sitemap.xml?shard=1&v=2"]);
  });

  test("leaves unescaped URLs untouched", () => {
    const data = parseSitemap(urlset("https://example.com/plain"), "https://example.com/s.xml");
    expect(data.urls[0]?.loc).toBe("https://example.com/plain");
  });
});
