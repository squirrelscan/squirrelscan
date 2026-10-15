// pub#807: an own-site-only audit (`--offline`) leaves sitemap URLs on another
// host unchecked. crawl/sitemap-4xx says how many on a row of its own, so its
// pass does not read as covering them.

import { describe, expect, test } from "bun:test";

import { sitemap4xxRule } from "../src/crawl/sitemap-4xx";
import type { ParsedPage, RuleContext, SitemapUrlStatusData } from "../src/types";

const BASE = "https://site.example.com";

function ctx(statuses: SitemapUrlStatusData[], sitemapOffSiteSkipped?: number): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: [],
      robotsTxt: null,
      sitemaps: {
        discovered: [{ url: `${BASE}/sitemap.xml`, urls: [], urlCount: 0 }],
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: 0,
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
      sitemapUrlStatuses: statuses,
      ...(sitemapOffSiteSkipped === undefined ? {} : { sitemapOffSiteSkipped }),
    },
    options: {},
  } as unknown as RuleContext;
}

describe("crawl/sitemap-4xx and off-site sitemap URLs left unchecked (pub#807)", () => {
  test("the skipped count is reported as info beside the checked URLs' pass", () => {
    const { checks } = sitemap4xxRule.run(
      ctx([{ url: `${BASE}/a`, status: 200, error: null }], 3),
    );
    expect(checks.find((c) => c.name === "sitemap-4xx")?.status).toBe("pass");
    const offSite = checks.find((c) => c.name === "sitemap-off-site-not-checked");
    expect(offSite?.status).toBe("info");
    expect(offSite?.message).toBe("3 sitemap URL(s) on another host not checked this audit");
    expect(offSite?.details).toEqual({ total: 3 });
  });

  test("it is reported when every sitemap URL was off-site, too", () => {
    const { checks } = sitemap4xxRule.run(ctx([], 2));
    expect(checks.find((c) => c.name === "sitemap-off-site-not-checked")?.status).toBe("info");
  });

  test("no row when nothing was skipped", () => {
    for (const skipped of [undefined, 0]) {
      const { checks } = sitemap4xxRule.run(
        ctx([{ url: `${BASE}/a`, status: 200, error: null }], skipped),
      );
      expect(checks.some((c) => c.name === "sitemap-off-site-not-checked")).toBe(false);
    }
  });
});
