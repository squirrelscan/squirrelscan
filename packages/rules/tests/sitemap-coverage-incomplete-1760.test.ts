// crawl/sitemap-coverage: a truncated or partly read sitemap corpus cannot say a crawled
// page is missing from the sitemap, so the rule reports not checked (#1760).

import { describe, expect, test } from "bun:test";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import type { SitemapDiscovery } from "@squirrelscan/core-contracts";
import type { ParsedPage, RuleContext } from "../src/types";

const ok = (path: string) => ({
  url: `https://example.com${path}`,
  statusCode: 200,
  parsed: { meta: {} } as unknown as ParsedPage,
});

function ctx(over: Partial<SitemapDiscovery>, precomputed: boolean): RuleContext {
  const urls = [{ loc: "https://example.com/" }];
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [ok("/"), ok("/listed-in-unread-child")],
      robotsTxt: null,
      sitemaps: {
        discovered: [
          { url: "https://example.com/sitemap.xml", type: "urlset", urls, childSitemaps: [], errors: [], urlCount: 1 },
        ],
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: 1,
        orphanPages: [],
        missingPages: precomputed ? ["https://example.com/listed-in-unread-child"] : [],
        failed: [],
        ...over,
      },
    },
    options: {},
  } as unknown as RuleContext;
}

const cov = async (c: RuleContext) =>
  ((await sitemapCoverageRule.run(c)) as { checks: Array<{ name: string; status: string; skipReason?: string }> })
    .checks.find((x) => x.name === "sitemap-coverage");

describe("crawl/sitemap-coverage with an incomplete sitemap corpus (#1760)", () => {
  for (const precomputed of [true, false]) {
    for (const state of [{ truncated: true }, { readState: "partial" as const }, { readState: "unreadable" as const }]) {
      test(`${JSON.stringify(state)} (precomputed=${precomputed}) is not checked, not missing`, async () => {
        const c = await cov(ctx(state, precomputed));
        expect(c?.status).toBe("skipped");
        expect(c?.skipReason).toContain("incomplete");
      });
    }
    test(`absent readState (precomputed=${precomputed}) is unknown, not checked (#1869)`, async () => {
      const c = await cov(ctx({}, precomputed));
      expect(c?.status).toBe("skipped");
      expect(c?.skipReason).toContain("unknown");
    });
    test(`control: a complete corpus (precomputed=${precomputed}) still warns`, async () => {
      const c = await cov(ctx({ readState: "complete" }, precomputed));
      expect(c?.status).toBe("warn");
    });
  }
});
