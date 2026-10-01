// The output caps of repo#2320 (crawl/sitemap-domain, sitemap-orphans) and the
// shared-bundle grouping of repo#2341 (perf/source-maps) change what a report
// lists, never the health score: scored here against the checks the rules
// used to emit.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SitemapDiscovery } from "@squirrelscan/core-contracts";
import {
  crawl,
  perf,
  type ParsedPage,
  type Rule,
  type RuleContext,
  type RuleRunResult,
} from "@squirrelscan/rules";

import { parsePage } from "@squirrelscan/parser";

import { calculateHealthScore } from "../src/scoring";

const { sitemapCoverageRule, sitemapDomainRule } = crawl;
const { sourceMapsRule } = perf;

const BASE = "https://example.com";

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  return result.checks;
}

function score(rule: Rule, checks: CheckResult[]): number {
  const results = new Map<string, RuleRunResult>([[rule.meta.id, { meta: rule.meta, checks }]]);
  return calculateHealthScore({ results }).overall;
}

function sitemapCtx(locs: string[], orphans: string[] = [], orphanTotal?: number): RuleContext {
  const sitemaps: SitemapDiscovery = {
    discovered: [
      {
        url: `${BASE}/sitemap.xml`,
        type: "urlset",
        urls: locs.map((loc) => ({ loc })),
        childSitemaps: [],
        errors: [],
        urlCount: locs.length,
      },
    ],
    sources: { robotsTxt: [], commonLocations: [] },
    totalUrls: locs.length,
    orphanPages: orphans,
    missingPages: [],
    ...(orphanTotal !== undefined ? { orphanPagesTotal: orphanTotal } : {}),
    failed: [],
  };
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: [{ url: `${BASE}/`, statusCode: 200, parsed: { meta: {} } as unknown as ParsedPage }],
      robotsTxt: null,
      sitemaps,
      crawlLimits: { pagesCrawled: 1, maxPages: 100 },
    },
    options: {},
  } as unknown as RuleContext;
}

describe("health score is unchanged by the output caps (repo#2320)", () => {
  for (const count of [3, 30, 51, 250_000]) {
    test(`crawl/sitemap-domain with ${count} off-domain URLs`, () => {
      const locs = Array.from({ length: count }, (_, i) => `https://other.example.net/p/${i}`);
      const capped = run(sitemapDomainRule, sitemapCtx(locs));
      // What the rule emitted before: every URL an item, no truncation keys.
      const uncapped: CheckResult[] = [
        {
          ...capped[0]!,
          items: locs.map((id) => ({ id, meta: { host: "other.example.net" } })),
          details: {},
        },
      ];
      expect(capped[0]?.status).toBe("fail");
      expect(score(sitemapDomainRule, capped)).toBe(score(sitemapDomainRule, uncapped));
    });
  }

  test("crawl/sitemap-coverage sitemap-orphans past the engine's array cap", () => {
    const orphans = Array.from({ length: 10_000 }, (_, i) => `${BASE}/o/${i}`);
    const capped = run(sitemapCoverageRule, sitemapCtx([`${BASE}/`], orphans, 250_000));
    const orphanCheck = capped.find((c) => c.name === "sitemap-orphans")!;
    const uncapped = capped.map((c) =>
      c === orphanCheck ? { ...c, items: orphans.map((id) => ({ id })), details: {} } : c
    );
    expect(orphanCheck.status).toBe("warn");
    expect(score(sitemapCoverageRule, capped)).toBe(score(sitemapCoverageRule, uncapped));
  });
});

describe("health score is unchanged by source-map grouping (repo#2341)", () => {
  test("a site of shared, section and page-only maps scores as the per-page checks did", () => {
    const pages = ["/", "/a", "/docs/1", "/docs/2", "/clean"].map((p) => `${BASE}${p}`);
    const docs = pages.filter((p) => p.includes("/docs/"));
    const loaded = pages.filter((p) => !p.endsWith("/clean"));
    const js = (path: string, sourcePages: string[]) => ({
      url: `${BASE}${path}`,
      status: 200,
      error: null,
      contentType: "application/javascript",
      sizeBytes: 10,
      content: `x();\n//# sourceMappingURL=${path.split("/").pop()}.map`,
      sourcePages,
    });
    const scripts = [js("/app.js", loaded), js("/docs.js", docs), js("/home.js", [`${BASE}/`])];
    const tags: Record<string, string[]> = {
      [`${BASE}/`]: ["/app.js", "/home.js"],
      [`${BASE}/a`]: ["/app.js"],
      [`${BASE}/docs/1`]: ["/app.js", "/docs.js"],
      [`${BASE}/docs/2`]: ["/app.js", "/docs.js"],
      [`${BASE}/clean`]: [],
    };
    const after: CheckResult[] = [];
    const before: CheckResult[] = [];
    for (const url of pages) {
      const html = `<!DOCTYPE html><html><head><title>t</title>${(tags[url] ?? [])
        .map((src) => `<script src="${src}"></script>`)
        .join("")}</head><body>x</body></html>`;
      const checks = run(sourceMapsRule, {
        page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
        parsed: parsePage(html, url),
        site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, scripts },
        options: {},
      } as unknown as RuleContext).map((c) => ({ ...c, pageUrl: url }));
      after.push(...checks);
      // What the rule emitted per page before: one check with every map.
      const maps = checks.filter((c) => c.name === "source-maps-exposed").flatMap((c) => c.items ?? []);
      before.push(
        ...(maps.length > 0
          ? [
              {
                name: "source-maps-exposed",
                status: "warn" as const,
                message: `${maps.length} potential source map(s) detected`,
                items: maps,
                pageUrl: url,
              },
            ]
          : checks)
      );
    }
    expect(after.filter((c) => c.status === "warn").length).toBe(7);
    expect(after.filter((c) => c.status === "pass")).toEqual(before.filter((c) => c.status === "pass"));
    expect(score(sourceMapsRule, after)).toBe(score(sourceMapsRule, before));
  });
});
