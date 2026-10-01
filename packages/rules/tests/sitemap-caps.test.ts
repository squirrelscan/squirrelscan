// crawl/sitemap-domain and the two sitemap-orphans checks list a bounded
// sample of URLs and keep the exact count (repo#2320). Before, one check
// carried every off-domain sitemap URL: 250,000 items and affected pages, most
// of an 80 MB report. Small lists are unchanged.

import { describe, expect, test } from "bun:test";

import type { SitemapDiscovery } from "@squirrelscan/core-contracts";

import { sitemapCoverageRule } from "../src/crawl/sitemap-coverage";
import { sitemapDomainRule } from "../src/crawl/sitemap-domain";
import { sitemapValidRule } from "../src/crawl/sitemap-valid";
import { URL_ITEM_SAMPLE, sampleUrlItems } from "../src/shared/sample-items";
import type { CheckResult, ParsedPage, Rule, RuleContext } from "../src/types";

const BASE = "https://example.com";

function urls(count: number, origin: string): string[] {
  return Array.from({ length: count }, (_, i) => `${origin}/p/${i}`);
}

function sitemaps(over: Partial<SitemapDiscovery> & { locs?: string[] }): SitemapDiscovery {
  const locs = over.locs ?? [];
  return {
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
    totalUrls: over.totalUrls ?? locs.length,
    orphanPages: over.orphanPages ?? [],
    missingPages: over.missingPages ?? [],
    ...(over.orphanPagesTotal !== undefined ? { orphanPagesTotal: over.orphanPagesTotal } : {}),
    failed: [],
  };
}

function check(rule: Rule, sm: SitemapDiscovery, name: string): CheckResult {
  const ctx = {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: BASE,
      pages: [{ url: `${BASE}/`, statusCode: 200, parsed: { meta: {} } as unknown as ParsedPage }],
      robotsTxt: null,
      sitemaps: sm,
      crawlLimits: { pagesCrawled: 1, maxPages: 100 },
    },
    options: {},
  } as unknown as RuleContext;
  const result = rule.run(ctx);
  if (result instanceof Promise) throw new Error("rule is async");
  const found = result.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} check`);
  return found;
}

describe("sampleUrlItems", () => {
  test("keeps a short list whole and stamps nothing", () => {
    const items = urls(3, BASE).map((id) => ({ id }));
    expect(sampleUrlItems(items)).toEqual({ items, truncation: {} });
  });

  test("samples a long list and stamps the dropped count and the true total", () => {
    const items = urls(120, BASE).map((id) => ({ id }));
    const { items: sample, truncation } = sampleUrlItems(items);
    expect(sample).toEqual(items.slice(0, URL_ITEM_SAMPLE));
    expect(truncation).toEqual({ additional: 120 - URL_ITEM_SAMPLE, pagesTruncated: 120 });
  });

  test("stamps the distinct URL count, not the item count, as the page total", () => {
    const items = [...Array.from({ length: 70 }, () => ({ id: `${BASE}/a` })), { id: `${BASE}/b` }];
    expect(sampleUrlItems(items, items.length, 2).truncation).toEqual({
      additional: 21,
      pagesTruncated: 2,
    });
  });

  test("takes the real total for a list already cut upstream", () => {
    const items = urls(10, BASE).map((id) => ({ id }));
    expect(sampleUrlItems(items, 250_000).truncation).toEqual({
      additional: 250_000 - 10,
      pagesTruncated: 250_000,
    });
  });
});

describe("crawl/sitemap-domain (repo#2320)", () => {
  test("a synthetic 50,000-URL off-domain sitemap: bounded sample, exact count, same status", () => {
    const locs = urls(50_000, "https://other.example.net");
    const c = check(sitemapDomainRule, sitemaps({ locs }), "sitemap-domain");
    expect(c.status).toBe("fail");
    expect(c.message).toBe("50000 URL(s) point to different domain(s)");
    expect(c.items).toHaveLength(URL_ITEM_SAMPLE);
    expect(c.items?.[0]).toEqual({ id: locs[0], meta: { host: "other.example.net" } });
    expect(c.details).toMatchObject({
      total: 50_000,
      additional: 50_000 - URL_ITEM_SAMPLE,
      pagesTruncated: 50_000,
      expectedHost: "example.com",
      foundHosts: ["other.example.net"],
    });
  });

  test("250,000 off-domain URLs serialize to a few kilobytes, not tens of megabytes", () => {
    const locs = urls(250_000, "https://other.example.net");
    const c = check(sitemapDomainRule, sitemaps({ locs }), "sitemap-domain");
    expect(c.message).toBe("250000 URL(s) point to different domain(s)");
    expect(JSON.stringify(c).length).toBeLessThan(10_000);
  });

  test("hundreds of distinct off-domain hosts are sampled, with the host count", () => {
    const locs = Array.from({ length: 300 }, (_, i) => `https://h${i}.example.net/`);
    const c = check(sitemapDomainRule, sitemaps({ locs }), "sitemap-domain");
    expect(c.details?.foundHosts).toHaveLength(URL_ITEM_SAMPLE);
    expect(c.details?.hostCount).toBe(300);
  });

  test("a URL listed many times counts once as an affected page", () => {
    const locs = [...Array.from({ length: 60 }, () => "https://other.example.net/same"), `${BASE}/`];
    const c = check(sitemapDomainRule, sitemaps({ locs }), "sitemap-domain");
    expect(c.message).toBe("60 URL(s) point to different domain(s)");
    expect(c.items).toHaveLength(URL_ITEM_SAMPLE);
    expect(c.details?.additional).toBe(10);
    expect(c.details?.pagesTruncated).toBeUndefined();
  });

  test("a short list is reported in full, as before", () => {
    const locs = [...urls(3, "https://other.example.net"), ...urls(5, BASE)];
    const c = check(sitemapDomainRule, sitemaps({ locs }), "sitemap-domain");
    expect(c.items).toHaveLength(3);
    expect(c.details).toEqual({
      total: 3,
      expectedHost: "example.com",
      foundHosts: ["other.example.net"],
    });
  });
});

describe("sitemap-orphans (repo#2320)", () => {
  // The engine hands rules at most REPORT_LIMITS.maxPages orphans, with the
  // count before that cut alongside.
  const cut = urls(10_000, BASE);

  test("crawl/sitemap-coverage: message and total are the real count, items a sample", () => {
    const c = check(
      sitemapCoverageRule,
      sitemaps({ orphanPages: cut, orphanPagesTotal: 250_000, totalUrls: 250_001 }),
      "sitemap-orphans"
    );
    expect(c.status).toBe("warn");
    expect(c.message).toBe("250000 sitemap URL(s) were not crawled");
    expect(c.items).toHaveLength(URL_ITEM_SAMPLE);
    expect(c.details).toEqual({
      additional: 250_000 - URL_ITEM_SAMPLE,
      pagesTruncated: 250_000,
      total: 250_000,
    });
  });

  test("crawl/sitemap-valid: the same, at info", () => {
    const c = check(
      sitemapValidRule,
      sitemaps({ orphanPages: cut, orphanPagesTotal: 250_000 }),
      "sitemap-orphans"
    );
    expect(c.status).toBe("info");
    expect(c.message).toBe("250000 URL(s) in sitemap not found during crawl");
    expect(c.items).toHaveLength(URL_ITEM_SAMPLE);
    expect(c.details).toMatchObject({ total: 250_000, pagesTruncated: 250_000 });
  });

  test("without an engine total the list length is the count", () => {
    const c = check(sitemapCoverageRule, sitemaps({ orphanPages: urls(2, BASE) }), "sitemap-orphans");
    expect(c.message).toBe("2 sitemap URL(s) were not crawled");
    expect(c.items).toHaveLength(2);
    expect(c.details).toEqual({ total: 2 });
  });
});
