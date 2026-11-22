// crawl/sitemap-domain skips URL sets from sitemaps that robots.txt declares,
// on any host (squirrelscan/squirrelscan#2225).

import type { SitemapDiscovery } from "@squirrelscan/core-contracts";

import { describe, expect, test } from "bun:test";

import type { RuleContext } from "../src/types";

import { sitemapDomainRule } from "../src/crawl/sitemap-domain";

const BASE = "https://kadeep.ai";
const DOCS_INDEX = "https://docs.kadeep.ai/sitemap-index.xml";
const DOCS_CHILD = "https://docs.kadeep.ai/sitemap-0.xml";

function run(declared: string[], discovered: SitemapDiscovery["discovered"]) {
  const ctx = {
    page: {
      url: `${BASE}/`,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: {},
    site: {
      baseUrl: BASE,
      pages: [],
      robotsTxt: null,
      sitemaps: {
        discovered,
        sources: { robotsTxt: declared, commonLocations: [] },
        totalUrls: 0,
        orphanPages: [],
        missingPages: [],
        failed: [],
      },
    },
    options: {},
  } as unknown as RuleContext;
  const result = sitemapDomainRule.run(ctx);
  if (result instanceof Promise) throw new Error("async");
  return result.checks[0]!;
}

const entry = (url: string, locs: string[], childSitemaps: string[] = []) => ({
  url,
  type: childSitemaps.length ? ("index" as const) : ("urlset" as const),
  urls: locs.map((loc) => ({ loc })),
  childSitemaps,
  errors: [],
  urlCount: locs.length,
});

describe("crawl/sitemap-domain robots.txt declarations", () => {
  test("robots-declared cross-host sitemap and its children do not flag", () => {
    const c = run(
      [DOCS_INDEX],
      [
        entry(DOCS_INDEX, [], [DOCS_CHILD]),
        entry(DOCS_CHILD, [
          "https://docs.kadeep.ai/a",
          "https://docs.kadeep.ai/b",
        ]),
      ]
    );
    expect(c.status).toBe("pass");
    expect(c.message).toContain("declared in robots.txt");
  });

  test("foreign-host sitemap not declared in robots.txt still flags", () => {
    const c = run([], [entry(DOCS_CHILD, ["https://docs.kadeep.ai/a"])]);
    expect(c.status).toBe("fail");
    expect(c.message).toContain("not declared in robots.txt");
  });

  test("declared sitemap does not excuse an undeclared one", () => {
    const c = run(
      [DOCS_INDEX],
      [
        entry(DOCS_INDEX, ["https://docs.kadeep.ai/a"]),
        entry(`${BASE}/sitemap.xml`, ["https://evil.example/x"]),
      ]
    );
    expect(c.status).toBe("fail");
    expect(c.details?.total).toBe(1);
  });

  test("declared cross-host sitemap still flags URLs on a third host", () => {
    const c = run(
      [DOCS_INDEX],
      [
        entry(DOCS_INDEX, [
          "https://docs.kadeep.ai/a",
          "https://evil.example/x",
        ]),
      ]
    );
    expect(c.status).toBe("fail");
    expect(c.details?.total).toBe(1);
    expect(c.details?.foundHosts).toEqual(["evil.example"]);
  });
});
