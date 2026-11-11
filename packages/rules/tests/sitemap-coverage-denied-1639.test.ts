// crawl/sitemap-coverage: a sitemap URL the origin refused or rate limited is
// unknown, not an orphan (#1639). The denial evidence stays on the report.

import { describe, expect, test } from "bun:test";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const ok = (path: string) => ({
  url: `https://example.com${path}`,
  statusCode: 200,
  parsed: { meta: {} } as unknown as ParsedPage,
});

function ctx(over: {
  orphanPages: string[];
  fetchedTargets?: SiteData["fetchedTargets"];
  unfetchedPages?: number;
}): RuleContext {
  const urls = ["/", "/ok", ...over.orphanPages.map((u) => new URL(u).pathname)].map((p) => ({
    loc: `https://example.com${p}`,
  }));
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [ok("/"), ok("/ok")],
      robotsTxt: null,
      sitemaps: {
        discovered: [
          {
            url: "https://example.com/sitemap.xml",
            type: "urlset",
            urls,
            childSitemaps: [],
            errors: [],
            urlCount: urls.length,
          },
        ],
        sources: { robotsTxt: [], commonLocations: [] },
        totalUrls: urls.length,
        orphanPages: over.orphanPages,
        orphanPagesTotal: over.orphanPages.length,
        missingPages: [],
        failed: [],
      },
      fetchedTargets: over.fetchedTargets,
      unfetchedPages: over.unfetchedPages,
    },
    options: {},
  } as unknown as RuleContext;
}

describe("crawl/sitemap-coverage denied sitemap URLs (#1639)", () => {
  test("a 429 sitemap URL is info with evidence, not a sitemap-orphans warning", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: ["https://example.com/restricted"],
        fetchedTargets: [
          { url: "https://example.com/restricted", status: 429, rateLimited: true },
        ],
      }),
    );
    expect(checks.find((c) => c.name === "sitemap-orphans")).toBeUndefined();
    const unverified = checks.find((c) => c.name === "sitemap-unverified");
    expect(unverified?.status).toBe("info");
    expect(unverified?.items?.map((i) => i.id)).toEqual(["https://example.com/restricted"]);
    expect(unverified?.details).toMatchObject({ total: 1, statuses: [429], reasons: ["rate_limited"] });
  });

  test("a genuine orphan next to a denied URL is still a warning", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({
        orphanPages: ["https://example.com/restricted", "https://example.com/gone"],
        fetchedTargets: [
          { url: "https://example.com/restricted", status: 429, rateLimited: true },
        ],
      }),
    );
    const orphans = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphans?.status).toBe("warn");
    expect(orphans?.items?.map((i) => i.id)).toEqual(["https://example.com/gone"]);
    expect(orphans?.message).toContain("1 sitemap URL(s)");
  });

  test("all-200 control: no orphan and no unverified check", () => {
    const { checks } = sitemapCoverageRule.run(ctx({ orphanPages: [] }));
    expect(checks.some((c) => c.name === "sitemap-orphans")).toBe(false);
    expect(checks.some((c) => c.name === "sitemap-unverified")).toBe(false);
  });

  test("a crawl stopped with URLs queued reports unknown, not a warning", () => {
    const { checks } = sitemapCoverageRule.run(
      ctx({ orphanPages: ["https://example.com/late"], unfetchedPages: 40 }),
    );
    const orphans = checks.find((c) => c.name === "sitemap-orphans");
    expect(orphans?.status).toBe("info");
    expect(orphans?.message).toContain("may not be orphans");
  });
});
