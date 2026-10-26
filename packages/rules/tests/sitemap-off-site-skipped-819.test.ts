// squirrelscan/squirrelscan#819: an offline audit never requests a sitemap that
// robots.txt names on another site. The crawl records it as skipped
// (SITEMAP_OFF_SITE_SKIPPED_ERROR), and the sitemap rules must say it was not
// requested, not that the sitemap is missing or failed to load.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { SITEMAP_OFF_SITE_SKIPPED_ERROR } from "@squirrelscan/core-contracts/storage";

import { sitemapExistsRule } from "../src/crawl/sitemap-exists";
import { sitemapValidRule } from "../src/crawl/sitemap-valid";
import type { ParsedPage, RuleContext } from "../src/types";

const OFF_SITE = "https://cdn.other.test/sitemap.xml";

function ctx(failed: Array<{ url: string; source: "robots.txt" | "common"; error: string }>) {
  return {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: {
        discovered: [],
        sources: { robotsTxt: [OFF_SITE], commonLocations: [] },
        totalUrls: 0,
        orphanPages: [],
        missingPages: [],
        failed,
      },
    },
    options: {},
  } as unknown as RuleContext;
}

const skipped = [{ url: OFF_SITE, source: "robots.txt" as const, error: SITEMAP_OFF_SITE_SKIPPED_ERROR }];

describe("crawl/sitemap-exists", () => {
  test("a sitemap named on another site and not requested is info, never 'No XML sitemap found'", () => {
    const { checks } = sitemapExistsRule.run(ctx(skipped)) as { checks: CheckResult[] };
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "sitemap-exists",
      status: "info",
      message: "1 sitemap(s) on another site were not requested",
    });
    expect(checks[0]?.items?.[0]?.id).toBe(OFF_SITE);
  });

  test("with nothing skipped, no sitemap is still a failure", () => {
    const { checks } = sitemapExistsRule.run(ctx([])) as { checks: CheckResult[] };
    expect(checks[0]).toMatchObject({ status: "fail", message: "No XML sitemap found" });
  });
});

describe("crawl/sitemap-valid", () => {
  test("a sitemap not requested is not a failed fetch", () => {
    const { checks } = sitemapValidRule.run(ctx(skipped)) as { checks: CheckResult[] };
    expect(checks.some((c) => c.name === "sitemap-fetch-failed")).toBe(false);
  });

  test("a real fetch failure still is", () => {
    const { checks } = sitemapValidRule.run(
      ctx([{ url: OFF_SITE, source: "robots.txt", error: "HTTP 500" }]),
    ) as { checks: CheckResult[] };
    expect(checks.find((c) => c.name === "sitemap-fetch-failed")?.status).toBe("fail");
  });
});
