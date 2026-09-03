// #1829 — a rate-limited target is not a broken one.
//
// A user managing ~53 Shopify storefronts reported pages and links flagged as
// 4xx that were really 429/430 throttling. These are the five rules that made
// that call. Each must move the target out of the failing set and into an info
// bucket that says the status is unverifiable, the way `broken-external-links`
// already did for WAF-blocked 403s.

import { describe, expect, test } from "bun:test";

import { brokenExternalLinksRule } from "../src/links/broken-external-links";
import { brokenLinksRule } from "../src/links/broken-links";
import { deadLinksRule } from "../src/links/dead-links";
import { validateRedirectChain } from "../src/links/redirects";
import { sitemap4xxRule } from "../src/crawl/sitemap-4xx";
import type {
  ExternalLinkCheckData,
  ParsedPage,
  RuleContext,
  SitemapUrlStatusData,
} from "../src/types";

const BASE = "https://example.com";

function externalCtx(externalLinks: ExternalLinkCheckData[]): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: { baseUrl: BASE, pages: [], robotsTxt: null, sitemaps: null, externalLinks },
    options: {},
  } as unknown as RuleContext;
}

const link = (over: Partial<ExternalLinkCheckData> = {}): ExternalLinkCheckData => ({
  href: "https://other.example/",
  status: 200,
  error: null,
  sourcePages: [`${BASE}/`],
  ...over,
});

function check(checks: { name: string }[], name: string) {
  return checks.find((c) => c.name === name);
}

describe("links/broken-external-links — rate-limited targets (#1829)", () => {
  test("429 and 430 are not counted as broken", () => {
    const { checks } = brokenExternalLinksRule.run(
      externalCtx([
        link({ href: "https://a.example/", status: 429 }),
        link({ href: "https://b.example/", status: 430 }),
      ]),
    );
    const broken = check(checks, "broken-external-links")!;
    expect(broken.status).toBe("pass");
  });

  test("a Retry-After 503, flagged by the checker, is not broken either", () => {
    // 503 is not recoverable from the status alone, so the checker persists the
    // verdict; the rule must honour the flag rather than re-deriving it.
    const { checks } = brokenExternalLinksRule.run(
      externalCtx([link({ href: "https://c.example/", status: 503, rateLimited: true })]),
    );
    expect(check(checks, "broken-external-links")!.status).toBe("pass");
  });

  test("they are reported as info with the status called unverifiable", () => {
    const { checks } = brokenExternalLinksRule.run(
      externalCtx([link({ href: "https://a.example/", status: 429 })]),
    );
    const info = check(checks, "rate-limited-external-links")!;
    expect(info.status).toBe("info");
    expect(info.message).toContain("unverifiable");
    expect(info.items?.[0]?.id).toBe("https://a.example/");
  });

  test("a genuine 404 is still broken", () => {
    const { checks } = brokenExternalLinksRule.run(
      externalCtx([
        link({ href: "https://dead.example/", status: 404 }),
        link({ href: "https://slow.example/", status: 429 }),
      ]),
    );
    const broken = check(checks, "broken-external-links")!;
    expect(broken.status).toBe("warn");
    expect(broken.items?.length).toBe(1);
    expect(broken.items?.[0]?.id).toBe("https://dead.example/");
  });

  test("a bare 503 with no Retry-After stays broken", () => {
    const { checks } = brokenExternalLinksRule.run(
      externalCtx([link({ href: "https://down.example/", status: 503 })]),
    );
    expect(check(checks, "broken-external-links")!.status).toBe("warn");
  });
});

describe("links/dead-links — rate-limited targets (#1829)", () => {
  test("throttled links are excluded from the dead count and named in the message", () => {
    const { checks } = deadLinksRule.run(
      externalCtx([
        link({ href: "https://ok.example/", status: 200 }),
        link({ href: "https://throttled.example/", status: 429 }),
      ]),
    );
    expect(checks[0]!.value).toBe(0);
    expect(checks[0]!.message).toContain("rate-limited");
  });

  test("a real dead link is still counted alongside a throttled one", () => {
    const { checks } = deadLinksRule.run(
      externalCtx([
        link({ href: "https://dead.example/", status: 404 }),
        link({ href: "https://throttled.example/", status: 430 }),
      ]),
    );
    expect(checks[0]!.value).toBe(1);
  });
});

describe("links/broken-links — rate-limited internal pages (#1829)", () => {
  function pageCtx(pages: { url: string; statusCode: number; links: string[] }[]): RuleContext {
    return {
      page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      site: {
        baseUrl: BASE,
        robotsTxt: null,
        sitemaps: null,
        pages: pages.map((p) => ({
          url: p.url,
          statusCode: p.statusCode,
          parsed: {
            links: p.links.map((url) => ({ url, isInternal: true, text: "", rel: null })),
          } as unknown as ParsedPage,
        })),
      },
      options: {},
    } as unknown as RuleContext;
  }

  test("a 429 target is not a broken internal link", () => {
    const { checks } = brokenLinksRule.run(
      pageCtx([
        { url: `${BASE}/`, statusCode: 200, links: [`${BASE}/throttled`] },
        { url: `${BASE}/throttled`, statusCode: 429, links: [] },
      ]),
    );
    const broken = check(checks, "broken-links")!;
    expect(broken.status).toBe("pass");
    expect(check(checks, "rate-limited-links")!.status).toBe("info");
  });

  test("a 404 target is still a broken internal link", () => {
    const { checks } = brokenLinksRule.run(
      pageCtx([
        { url: `${BASE}/`, statusCode: 200, links: [`${BASE}/gone`] },
        { url: `${BASE}/gone`, statusCode: 404, links: [] },
      ]),
    );
    expect(check(checks, "broken-links")!.status).toBe("fail");
  });
});

describe("crawl/sitemap-4xx — rate-limited sitemap URLs (#1829)", () => {
  function sitemapCtx(statuses: SitemapUrlStatusData[]): RuleContext {
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
      },
      options: {},
    } as unknown as RuleContext;
  }

  const entry = (over: Partial<SitemapUrlStatusData>): SitemapUrlStatusData => ({
    url: `${BASE}/p`,
    status: 200,
    error: null,
    ...over,
  });

  test("429 and 430 are inside the 4xx band but are not sitemap rot", () => {
    const { checks } = sitemap4xxRule.run(
      sitemapCtx([
        entry({ url: `${BASE}/a`, status: 429 }),
        entry({ url: `${BASE}/b`, status: 430 }),
      ]),
    );
    expect(check(checks, "sitemap-4xx")!.status).toBe("pass");
    const info = check(checks, "sitemap-rate-limited")!;
    expect(info.status).toBe("info");
    expect(info.items?.length).toBe(2);
  });

  test("a Retry-After 503 flagged by the checker is excluded too", () => {
    const { checks } = sitemap4xxRule.run(
      sitemapCtx([entry({ url: `${BASE}/a`, status: 503, rateLimited: true })]),
    );
    expect(check(checks, "sitemap-4xx")!.status).toBe("pass");
    expect(check(checks, "sitemap-rate-limited")!.status).toBe("info");
  });

  test("a genuine 404 in the sitemap is still reported", () => {
    const { checks } = sitemap4xxRule.run(
      sitemapCtx([
        entry({ url: `${BASE}/gone`, status: 404 }),
        entry({ url: `${BASE}/slow`, status: 429 }),
      ]),
    );
    const bad = check(checks, "sitemap-4xx")!;
    expect(bad.status).toBe("warn");
    expect(bad.items?.length).toBe(1);
    expect(bad.items?.[0]?.id).toBe(`${BASE}/gone`);
  });
});

describe("links/redirects — a chain ending in a rate limit (#1829)", () => {
  const chain = (over: Record<string, unknown>) => ({
    sourceUrl: `${BASE}/a`,
    finalUrl: `${BASE}/b`,
    hops: [
      { url: `${BASE}/a`, statusCode: 301, type: "http" as const },
      { url: `${BASE}/b`, statusCode: 429, type: "http" as const },
    ],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
    ...over,
  });

  test("reports info, not a failing chain", () => {
    const checks = validateRedirectChain(chain({ endsRateLimited: true }));
    expect(check(checks, "redirect-to-error")).toBeUndefined();
    const info = check(checks, "redirect-rate-limited")!;
    expect(info.status).toBe("info");
    expect(info.message).toContain("unverifiable");
  });

  test("a chain that really ends in a 404 still fails", () => {
    const checks = validateRedirectChain(
      chain({
        endsInError: true,
        hops: [
          { url: `${BASE}/a`, statusCode: 301, type: "http" as const },
          { url: `${BASE}/b`, statusCode: 404, type: "http" as const },
        ],
      }),
    );
    expect(check(checks, "redirect-to-error")!.status).toBe("fail");
    expect(check(checks, "redirect-rate-limited")).toBeUndefined();
  });
});
