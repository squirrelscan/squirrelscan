// pub#2093: the sitemap parser keeps <image:image><image:loc> entries per <url>, capped.

import { describe, expect, test } from "bun:test";

import { parseSitemap, SITEMAP_MAX_IMAGES_PER_URL } from "../src/sitemaps";

const NS =
  'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
const wrap = (urls: string) => `<?xml version="1.0"?><urlset ${NS}>${urls}</urlset>`;

describe("image sitemap entries", () => {
  test("keeps every image:loc under its url, including a single one", () => {
    const data = parseSitemap(
      wrap(
        `<url><loc>https://example.com/a</loc><image:image><image:loc>https://cdn.example.com/1.jpg</image:loc></image:image>` +
          `<image:image><image:loc>https://cdn.example.com/2.jpg</image:loc><image:title>t</image:title></image:image></url>` +
          `<url><loc>https://example.com/b</loc></url>`,
      ),
      "https://example.com/sitemap.xml",
    );
    expect(data.urls[0]!.images).toEqual(["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"]);
    expect(data.urls[1]!.images).toBeUndefined();
    expect(data.urls[1]!.imagesTruncated).toBeUndefined();
  });

  test("decodes XML escapes and drops non-http image locs", () => {
    const data = parseSitemap(
      wrap(
        `<url><loc>https://example.com/a</loc>` +
          `<image:image><image:loc>https://cdn.example.com/1.jpg?a=1&amp;b=2</image:loc></image:image>` +
          `<image:image><image:loc>/relative.jpg</image:loc></image:image></url>`,
      ),
      "https://example.com/sitemap.xml",
    );
    expect(data.urls[0]!.images).toEqual(["https://cdn.example.com/1.jpg?a=1&b=2"]);
  });

  test("caps images per url and marks the entry truncated", () => {
    const n = SITEMAP_MAX_IMAGES_PER_URL + 5;
    const images = Array.from(
      { length: n },
      (_, i) => `<image:image><image:loc>https://cdn.example.com/${i}.jpg</image:loc></image:image>`,
    ).join("");
    const data = parseSitemap(wrap(`<url><loc>https://example.com/a</loc>${images}</url>`), "https://example.com/s.xml");
    expect(data.urls[0]!.images).toHaveLength(SITEMAP_MAX_IMAGES_PER_URL);
    expect(data.urls[0]!.imagesTruncated).toBe(true);
  });
});
