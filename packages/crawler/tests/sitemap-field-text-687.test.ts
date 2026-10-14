// #687: the sitemap parser turned a bare-year `<lastmod>2024</lastmod>` (a
// valid W3C Datetime) into the number 2024, and the extractor's `.trim()` then
// failed the whole file with "Parse error: entry.lastmod?.trim is not a
// function", so none of its URLs were read. Values now stay the text the
// sitemap wrote, and one entry with a field that is not plain text no longer
// costs the others.
import { describe, expect, test } from "bun:test";

import { parseSitemap } from "../src/sitemaps";

const SITEMAP_URL = "https://example.com/sitemap.xml";

function urlset(...entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map((entry) => `<url>${entry}</url>`)
    .join("")}</urlset>`;
}

describe("sitemap field values stay text (#687)", () => {
  test("a bare-year lastmod next to a full datetime parses with no errors", () => {
    const data = parseSitemap(
      urlset(
        "<loc>https://example.com/a</loc><lastmod>2024</lastmod>",
        "<loc>https://example.com/b</loc><lastmod>2024-05-01T10:00:00+00:00</lastmod>",
      ),
      SITEMAP_URL,
    );
    expect(data.errors).toEqual([]);
    expect(data.urls.map((u) => [u.loc, u.lastmod])).toEqual([
      ["https://example.com/a", "2024"],
      ["https://example.com/b", "2024-05-01T10:00:00+00:00"],
    ]);
  });

  test("numeric-looking values keep the text the sitemap wrote", () => {
    const data = parseSitemap(
      urlset(
        "<loc>https://example.com/a</loc><lastmod>2024</lastmod><changefreq>1</changefreq><priority>0.80</priority>",
      ),
      SITEMAP_URL,
    );
    expect(data.errors).toEqual([]);
    expect(data.urls).toEqual([
      { loc: "https://example.com/a", lastmod: "2024", changefreq: "1", priority: 0.8 },
    ]);
  });

  test("a field with attributes is read from its text", () => {
    const data = parseSitemap(
      urlset('<loc>https://example.com/a</loc><lastmod note="x">2024</lastmod>'),
      SITEMAP_URL,
    );
    expect(data.errors).toEqual([]);
    expect(data.urls[0]?.lastmod).toBe("2024");
  });
});

describe("one malformed entry does not discard the others (#687)", () => {
  test("a lastmod with markup inside is dropped and its URL kept", () => {
    const data = parseSitemap(
      urlset(
        "<loc>https://example.com/a</loc><lastmod><date>2024-01-01</date></lastmod>",
        "<loc>https://example.com/b</loc><lastmod>2024</lastmod>",
      ),
      SITEMAP_URL,
    );
    expect(data.errors).toEqual([]);
    expect(data.urls.map((u) => [u.loc, u.lastmod])).toEqual([
      ["https://example.com/a", undefined],
      ["https://example.com/b", "2024"],
    ]);
  });

  test("entries whose loc is not one text value are skipped, counted once, and the rest read", () => {
    const data = parseSitemap(
      urlset(
        "<loc>https://example.com/a</loc>",
        "<loc><b>https://example.com/nested</b></loc>",
        "<loc>https://example.com/twice-1</loc><loc>https://example.com/twice-2</loc>",
        "<loc>https://example.com/b</loc><lastmod>2024</lastmod>",
      ),
      SITEMAP_URL,
    );
    expect(data.urls.map((u) => u.loc)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(data.urlCount).toBe(2);
    expect(data.errors).toEqual(["2 <url> entries skipped: <loc> is not a single text value"]);
  });

  test("a sitemap index skips an unreadable child loc and keeps the others", () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      `<sitemap><loc>https://example.com/s1.xml</loc><lastmod>2024</lastmod></sitemap>` +
      `<sitemap><loc><i>https://example.com/s2.xml</i></loc></sitemap>` +
      `<sitemap><loc>https://example.com/s3.xml</loc></sitemap></sitemapindex>`;
    const data = parseSitemap(xml, "https://example.com/sitemap-index.xml");
    expect(data.childSitemaps).toEqual([
      "https://example.com/s1.xml",
      "https://example.com/s3.xml",
    ]);
    expect(data.errors).toEqual(["1 <sitemap> entry skipped: <loc> is not a single text value"]);
  });

  test("empty and text-only entries are still ignored without an error", () => {
    const data = parseSitemap(
      urlset("", "https://example.com/bare", "<loc></loc>", "<loc>https://example.com/a</loc>"),
      SITEMAP_URL,
    );
    expect(data.urls.map((u) => u.loc)).toEqual(["https://example.com/a"]);
    expect(data.errors).toEqual([]);
  });
});
