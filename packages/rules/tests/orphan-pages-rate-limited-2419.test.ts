// links/orphan-pages: a page whose possible linkers were rate limited is not
// checked, never an orphan (#2419).

import { describe, expect, test } from "bun:test";

import type { ParsedPage, RuleContext, SiteData } from "../src/types";

import { orphanPagesRule } from "../src/links/orphan-pages";

const BASE = "https://example.com";

function page(path: string, linksTo: string[]) {
  return {
    url: `${BASE}${path}`,
    statusCode: 200,
    headers: {},
    parsed: {
      meta: {},
      links: linksTo.map((to) => ({
        url: `${BASE}${to}`,
        isInternal: true,
        isNofollow: false,
      })),
    } as unknown as ParsedPage,
  };
}

function ctx(
  pages: ReturnType<typeof page>[],
  fetchedTargets?: SiteData["fetchedTargets"]
): RuleContext {
  return {
    page: {
      url: `${BASE}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {} as ParsedPage,
    options: { minInboundLinks: 2, excludePatterns: [] },
    site: { baseUrl: BASE, pages, robotsTxt: null, fetchedTargets },
  } as unknown as RuleContext;
}

// /p1 has one inbound link here because /p2, its other linker, answered 429.
const pages = [page("/", ["/p1", "/p2"]), page("/p1", ["/", "/p2"])];

describe("links/orphan-pages with rate-limited pages (#2419)", () => {
  test("skips instead of warning when a page was rate limited", async () => {
    const result = await orphanPagesRule.run(
      ctx(pages, [{ url: `${BASE}/p2`, status: 429, rateLimited: true }])
    );
    expect(result.checks[0]?.status).toBe("skipped");
  });

  test("control: still warns without the rate-limited page", async () => {
    const result = await orphanPagesRule.run(ctx(pages));
    expect(result.checks[0]?.status).toBe("warn");
  });

  test("a non-rate-limited fetched target does not skip", async () => {
    const result = await orphanPagesRule.run(
      ctx(pages, [{ url: `${BASE}/p2`, status: 404 }])
    );
    expect(result.checks[0]?.status).toBe("warn");
  });
});
