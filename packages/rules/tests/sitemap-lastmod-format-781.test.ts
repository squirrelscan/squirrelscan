// #781 — the sitemap protocol requires `<lastmod>` in W3C Datetime. No rule
// reported one in another format, and a search engine may ignore a lastmod it
// cannot read. crawl/sitemap-valid now does, naming a datetime with no zone as
// that rather than as unreadable.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SitemapData } from "@squirrelscan/core-contracts";

import { sitemapValidRule } from "../src/crawl/sitemap-valid";
import type { ParsedPage, RuleContext } from "../src/types";

function ctx(lastmods: string[]): RuleContext {
  const discovered: SitemapData[] = [
    {
      url: "https://example.com/sitemap.xml",
      type: "urlset",
      urls: lastmods.map((lastmod, i) => ({ loc: `https://example.com/p${i}`, lastmod })),
      childSitemaps: [],
      errors: [],
      urlCount: lastmods.length,
    },
  ];
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
        totalUrls: lastmods.length,
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
    },
    options: {},
  } as unknown as RuleContext;
}

function checks(lastmods: string[]): CheckResult[] {
  return (sitemapValidRule.run(ctx(lastmods)) as { checks: CheckResult[] }).checks;
}

const named = (all: CheckResult[], name: string) => all.find((c) => c.name === name);

describe("crawl/sitemap-valid lastmod format (#781)", () => {
  test("values outside W3C Datetime are reported with their URLs", () => {
    const all = checks(["2024/09/10", "2024-9", "Tue, 10 Sep 2024 12:00:00 GMT", "2024-09-31", "2024-09-10"]);
    const format = named(all, "sitemap-lastmod-format");
    expect(format?.status).toBe("warn");
    expect(format?.message).toBe("4 sitemap lastmod value(s) are not in W3C Datetime format");
    expect(format?.items).toEqual([
      { id: "https://example.com/p0", label: 'lastmod "2024/09/10"' },
      { id: "https://example.com/p1", label: 'lastmod "2024-9"' },
      { id: "https://example.com/p2", label: 'lastmod "Tue, 10 Sep 2024 12:00:00 GMT"' },
      { id: "https://example.com/p3", label: 'lastmod "2024-09-31"' },
    ]);
    expect(named(all, "sitemap-lastmod-zone")).toBeUndefined();
  });

  test("a datetime with no zone is reported as missing its zone, not as unreadable", () => {
    const all = checks(["2024-09-10T12:00:00", "2024-09-10T12:00"]);
    const zone = named(all, "sitemap-lastmod-zone");
    expect(zone?.status).toBe("warn");
    expect(zone?.message).toBe("2 sitemap lastmod datetime(s) have no time zone");
    expect(zone?.items?.map((i) => i.label)).toEqual([
      'lastmod "2024-09-10T12:00:00"',
      'lastmod "2024-09-10T12:00"',
    ]);
    expect(named(all, "sitemap-lastmod-format")).toBeUndefined();
  });

  test("W3C values are not reported", () => {
    const all = checks([
      "2024",
      "2024-09",
      "2024-09-10",
      "2024-09-10T12:00Z",
      "2024-09-10T12:00:00Z",
      "2024-09-10T12:00:00.123+02:00",
      "2024-09-10T12:00:00+02:00",
    ]);
    expect(named(all, "sitemap-lastmod-format")).toBeUndefined();
    expect(named(all, "sitemap-lastmod-zone")).toBeUndefined();
  });

  test("a sitemap with no lastmod gets no lastmod check", () => {
    expect(named(checks([]), "sitemap-lastmod-format")).toBeUndefined();
  });

  test("a large sitemap keeps a sample and the exact count", () => {
    const all = checks(Array.from({ length: 300 }, () => "2024/09/10"));
    const format = named(all, "sitemap-lastmod-format");
    expect(format?.message).toBe("300 sitemap lastmod value(s) are not in W3C Datetime format");
    expect(format?.items?.length).toBeLessThan(300);
    expect(format?.details).toMatchObject({ total: 300, additional: 300 - (format?.items?.length ?? 0) });
  });
});
