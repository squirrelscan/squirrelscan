// Tests for processors/discovery/discover-sitemaps.ts - Sitemap parsing

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";

import {
  parseSitemap,
  getUrlsFromSitemaps,
  fetchSitemapsRecursive,
  discoverSitemaps,
} from "../../../../src/crawl/sitemaps";
import { initRequestTool } from "../../../../src/tools/request";

const originalFetch = globalThis.fetch;

const createFetchStub = (
  responses: Record<string, { status?: number; body?: string }>
) => {
  const calls: string[] = [];
  const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);
    const response = responses[url];
    if (!response) {
      return new Response("", { status: 404 });
    }
    return new Response(response.body ?? "", {
      status: response.status ?? 200,
    });
  };
  return { fetchStub, calls };
};

beforeEach(() => {
  // Use standard fetch for tests so we can mock globalThis.fetch
  initRequestTool({ rateLimitPerSecond: 1000 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseSitemap", () => {
  it("parses simple urlset sitemap", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page1</loc>
  </url>
  <url>
    <loc>https://example.com/page2</loc>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.type).toBe("urlset");
    expect(result.urls.length).toBe(2);
    expect(result.urls[0].loc).toBe("https://example.com/page1");
    expect(result.urls[1].loc).toBe("https://example.com/page2");
    expect(result.urlCount).toBe(2);
  });

  it("parses urlset with all fields", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls[0].loc).toBe("https://example.com/page");
    expect(result.urls[0].lastmod).toBe("2024-01-15");
    expect(result.urls[0].changefreq).toBe("weekly");
    expect(result.urls[0].priority).toBe(0.8);
  });

  it("parses sitemap index", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
</sitemapindex>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.type).toBe("index");
    expect(result.childSitemaps.length).toBe(2);
    expect(result.childSitemaps).toContain(
      "https://example.com/sitemap-posts.xml"
    );
    expect(result.childSitemaps).toContain(
      "https://example.com/sitemap-pages.xml"
    );
    expect(result.urls.length).toBe(0);
    expect(result.urlCount).toBe(0);
  });

  it("handles whitespace in loc elements", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>
      https://example.com/page
    </loc>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls[0].loc).toBe("https://example.com/page");
  });

  it("handles URLs with special characters", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page?param=value&amp;other=123</loc>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    // XML entities should be preserved as-is since we're using regex
    expect(result.urls[0].loc).toBe(
      "https://example.com/page?param=value&amp;other=123"
    );
  });

  it("handles empty sitemap", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.type).toBe("urlset");
    expect(result.urls.length).toBe(0);
    expect(result.urlCount).toBe(0);
  });

  it("handles missing optional fields", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page</loc>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls[0].lastmod).toBeUndefined();
    expect(result.urls[0].changefreq).toBeUndefined();
    expect(result.urls[0].priority).toBeUndefined();
  });

  it("skips urls without loc", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <lastmod>2024-01-15</lastmod>
  </url>
  <url>
    <loc>https://example.com/valid</loc>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls.length).toBe(1);
    expect(result.urls[0].loc).toBe("https://example.com/valid");
  });

  it("handles large sitemaps", () => {
    const urls = Array.from(
      { length: 1000 },
      (_, i) => `<url><loc>https://example.com/page${i}</loc></url>`
    ).join("\n");

    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls.length).toBe(1000);
    expect(result.urlCount).toBe(1000);
  });

  it("handles malformed XML gracefully", () => {
    const content = `This is not valid XML at all`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    // Should not throw, returns empty
    expect(result.urls.length).toBe(0);
    expect(result.type).toBe("urlset");
  });

  it("parses priority as float", () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/high</loc>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/low</loc>
    <priority>0.1</priority>
  </url>
</urlset>`;

    const result = parseSitemap(content, "https://example.com/sitemap.xml");

    expect(result.urls[0].priority).toBe(1.0);
    expect(result.urls[1].priority).toBe(0.1);
  });
});

describe("getUrlsFromSitemaps", () => {
  it("extracts all URLs from multiple sitemaps", () => {
    const sitemaps = [
      {
        url: "https://example.com/sitemap1.xml",
        type: "urlset" as const,
        urls: [
          { loc: "https://example.com/page1" },
          { loc: "https://example.com/page2" },
        ],
        childSitemaps: [],
        errors: [],
        urlCount: 2,
      },
      {
        url: "https://example.com/sitemap2.xml",
        type: "urlset" as const,
        urls: [{ loc: "https://example.com/page3" }],
        childSitemaps: [],
        errors: [],
        urlCount: 1,
      },
    ];

    const urls = getUrlsFromSitemaps(sitemaps);

    expect(urls.length).toBe(3);
    expect(urls).toContain("https://example.com/page1");
    expect(urls).toContain("https://example.com/page2");
    expect(urls).toContain("https://example.com/page3");
  });

  it("returns empty array for empty sitemaps", () => {
    const urls = getUrlsFromSitemaps([]);
    expect(urls).toEqual([]);
  });

  it("handles index sitemaps (no URLs)", () => {
    const sitemaps = [
      {
        url: "https://example.com/sitemap-index.xml",
        type: "index" as const,
        urls: [],
        childSitemaps: ["https://example.com/sitemap1.xml"],
        errors: [],
        urlCount: 0,
      },
    ];

    const urls = getUrlsFromSitemaps(sitemaps);
    expect(urls).toEqual([]);
  });

  it("handles mixed index and urlset sitemaps", () => {
    const sitemaps = [
      {
        url: "https://example.com/sitemap-index.xml",
        type: "index" as const,
        urls: [],
        childSitemaps: [],
        errors: [],
        urlCount: 0,
      },
      {
        url: "https://example.com/sitemap.xml",
        type: "urlset" as const,
        urls: [{ loc: "https://example.com/page" }],
        childSitemaps: [],
        errors: [],
        urlCount: 1,
      },
    ];

    const urls = getUrlsFromSitemaps(sitemaps);
    expect(urls.length).toBe(1);
    expect(urls[0]).toBe("https://example.com/page");
  });
});

describe("fetchSitemapsRecursive", () => {
  it("deduplicates sitemap fetches by URL", async () => {
    const indexUrl = "https://example.com/sitemap-index.xml";
    const childUrl = "https://example.com/sitemap-child.xml";

    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${childUrl}</loc>
  </sitemap>
  <sitemap>
    <loc>${childUrl}</loc>
  </sitemap>
</sitemapindex>`;

    const childXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page</loc>
  </url>
</urlset>`;

    const { fetchStub, calls } = createFetchStub({
      [indexUrl]: { body: indexXml },
      [childUrl]: { body: childXml },
    });
    globalThis.fetch = fetchStub as typeof fetch;

    const result = await Effect.runPromise(
      fetchSitemapsRecursive([indexUrl, childUrl, childUrl], "SquirrelTest")
    );

    const urls = result.filter((r) => r.success).map((r) => r.data.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(calls.filter((url) => url === childUrl).length).toBe(1);
  });
});

describe("discoverSitemaps", () => {
  it("returns discovered entrypoints and all child sitemaps", async () => {
    const baseUrl = "https://example.com";
    const indexUrl = `${baseUrl}/sitemap.xml`;
    const childUrl = `${baseUrl}/sitemap-posts.xml`;

    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${childUrl}</loc>
  </sitemap>
</sitemapindex>`;

    const childXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/post</loc>
  </url>
</urlset>`;

    const { fetchStub } = createFetchStub({
      [indexUrl]: { body: indexXml },
      [childUrl]: { body: childXml },
    });
    globalThis.fetch = fetchStub as typeof fetch;

    const robotsTxt = {
      exists: true,
      url: `${baseUrl}/robots.txt`,
      content: "",
      sizeBytes: 0,
      sitemaps: [indexUrl],
      rules: [],
      errors: [],
    };

    const result = await Effect.runPromise(
      discoverSitemaps(baseUrl, robotsTxt, "SquirrelTest")
    );

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].url).toBe(indexUrl);
    expect(result.all.map((sitemap) => sitemap.url)).toContain(childUrl);
    expect(result.discovered.map((sitemap) => sitemap.url)).not.toContain(
      childUrl
    );
  });
});
