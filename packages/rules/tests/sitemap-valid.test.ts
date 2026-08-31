// crawl/sitemap-valid — index files must not be held to the per-file URL
// limit (#1651). The crawler stores the AGGREGATED child URL total as
// urlCount on a top-level index sitemap, so comparing that against the
// 50,000-URL per-file cap flagged every healthy sharded site on its index
// file ("/sitemap.xml exceeds 50,000 URL limit (121613 URLs)" while every
// shard was ≤40k). Indexes have their own protocol limit: 50,000 children.

import { describe, expect, test } from "bun:test";

import type { SitemapData } from "@squirrelscan/core-contracts";

import { sitemapValidRule } from "../src/crawl/sitemap-valid";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(discovered: SitemapData[]): RuleContext {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: {
        discovered,
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: discovered.reduce((sum, s) => sum + s.urlCount, 0),
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
    },
    options: {},
  } as unknown as RuleContext;
}

function sitemap(over: Partial<SitemapData>): SitemapData {
  return {
    url: "https://example.com/sitemap.xml",
    type: "urlset",
    urls: [],
    childSitemaps: [],
    errors: [],
    urlCount: 0,
    ...over,
  };
}

function sizeCheck(result: ReturnType<typeof sitemapValidRule.run>) {
  const checks = (result as { checks: Array<{ name: string; status: string; items?: Array<{ id: string }> }> })
    .checks;
  const check = checks.find((c) => c.name === "sitemap-size");
  expect(check).toBeDefined();
  return check as { name: string; status: string; items?: Array<{ id: string }> };
}

describe("crawl/sitemap-valid index vs per-file limits (#1651)", () => {
  test("an index whose aggregated urlCount exceeds 50k passes when shards are within limits", () => {
    const shards = Array.from({ length: 4 }, (_, i) =>
      sitemap({
        url: `https://example.com/sitemap-${i}.xml`,
        urlCount: 40000,
      }),
    );
    const index = sitemap({
      url: "https://example.com/sitemap.xml",
      type: "index",
      childSitemaps: shards.map((s) => s.url),
      urlCount: 160000, // crawler-aggregated child total
    });

    const check = sizeCheck(sitemapValidRule.run(ctx([index, ...shards])));
    expect(check.status).toBe("pass");
  });

  test("a urlset shard over 50k URLs fails and the finding names the shard, not the index", () => {
    const shard = sitemap({ url: "https://example.com/sitemap-big.xml", urlCount: 60000 });
    const index = sitemap({
      url: "https://example.com/sitemap.xml",
      type: "index",
      childSitemaps: [shard.url],
      urlCount: 60000,
    });

    const check = sizeCheck(sitemapValidRule.run(ctx([index, shard])));
    expect(check.status).toBe("warn");
    expect(check.items).toHaveLength(1);
    expect(check.items?.[0]?.id).toContain("sitemap-big.xml");
  });

  test("an index listing more than 50k child sitemaps fails on the child limit", () => {
    const index = sitemap({
      url: "https://example.com/sitemap.xml",
      type: "index",
      childSitemaps: Array.from({ length: 50001 }, (_, i) => `https://example.com/s-${i}.xml`),
      urlCount: 0,
    });

    const check = sizeCheck(sitemapValidRule.run(ctx([index])));
    expect(check.status).toBe("warn");
    expect(check.items?.[0]?.id).toContain("50001 child sitemaps");
  });

  test("a plain oversized urlset still fails", () => {
    const check = sizeCheck(sitemapValidRule.run(ctx([sitemap({ urlCount: 50001 })])));
    expect(check.status).toBe("warn");
  });
});
