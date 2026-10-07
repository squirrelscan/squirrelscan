// A root fetch the site REFUSED is not a finding about the site.
//
// The crawler records each refusal on `SiteData.refusedFetches`; the rules that
// would assert an absence say "not checked" instead, and the runner skips them
// outright when the crawl fetched no page at all.

import { describe, expect, test } from "bun:test";

import type { RefusedFetch, RobotsTxtData, SitemapDiscovery } from "@squirrelscan/core-contracts";

import { llmsTxtRule } from "../src/ax/llms-txt";
import { markdownResponseRule } from "../src/ax/markdown-response";
import { robotsTxtRule } from "../src/crawl/robots-txt";
import { sitemapExistsRule } from "../src/crawl/sitemap-exists";
import { refusalReason, refusedFor } from "../src/refused";
import type { RuleNamespace } from "../src/loader";
import { RuleRunner } from "../src/runner";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

const BASE = "https://example.com";

const WALL = (resource: RefusedFetch["resource"], path: string): RefusedFetch => ({
  url: `${BASE}${path}`,
  resource,
  status: 403,
  provider: "Cloudflare",
});

function site(over: Partial<SiteData> = {}): SiteData {
  return {
    baseUrl: BASE,
    pages: [],
    robotsTxt: null,
    sitemaps: null,
    ...over,
  };
}

function ctx(data: SiteData): RuleContext {
  return {
    page: { url: `${BASE}/`, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: data,
  };
}

const NO_SITEMAPS: SitemapDiscovery = {
  discovered: [],
  sources: { robotsTxt: [], commonLocations: [] },
  totalUrls: 0,
  orphanPages: [],
  missingPages: [],
  failed: [],
} as unknown as SitemapDiscovery;

const UNREACHABLE_ROBOTS: RobotsTxtData = {
  exists: false,
  url: `${BASE}/robots.txt`,
  content: null,
  sizeBytes: 0,
  sitemaps: [],
  rules: [],
  errors: ["HTTP 403"],
};

describe("refused helpers", () => {
  test("refusedFor picks only the named resource", () => {
    const data = site({
      refusedFetches: [WALL("sitemap", "/sitemap.xml"), WALL("llms.txt", "/llms.txt")],
    });
    expect(refusedFor(data, "sitemap").map((r) => r.url)).toEqual([`${BASE}/sitemap.xml`]);
    expect(refusedFor(data, "markdown")).toEqual([]);
    expect(refusedFor(undefined, "sitemap")).toEqual([]);
  });

  test("refusalReason names the status and the vendor", () => {
    expect(refusalReason([WALL("sitemap", "/sitemap.xml")])).toBe("HTTP 403 (Cloudflare)");
    expect(refusalReason([{ url: `${BASE}/x`, resource: "sitemap", status: 429 }])).toBe("HTTP 429");
  });
});

describe("crawl/sitemap-exists", () => {
  test("control: no sitemap and nothing refused is still a failure", () => {
    const { checks } = sitemapExistsRule.run(ctx(site({ sitemaps: NO_SITEMAPS })));
    expect(checks[0]).toMatchObject({ status: "fail", message: "No XML sitemap found" });
  });

  test("a refused sitemap request is not a missing sitemap", () => {
    const { checks } = sitemapExistsRule.run(
      ctx(site({ sitemaps: NO_SITEMAPS, refusedFetches: [WALL("sitemap", "/sitemap.xml")] })),
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "sitemap-exists", status: "info", value: "refused" });
    expect(checks[0]!.message).toContain("refused");
    expect(checks[0]!.message).toContain("Cloudflare");
    expect(checks[0]!.message).not.toContain("No XML sitemap found");
  });

  test("a sitemap that WAS found still passes when a sibling location was refused", () => {
    const found = {
      ...NO_SITEMAPS,
      discovered: [{ url: `${BASE}/sitemap.xml`, type: "urlset", urls: [], childSitemaps: [], errors: [], urlCount: 3 }],
      totalUrls: 3,
    } as unknown as SitemapDiscovery;
    const { checks } = sitemapExistsRule.run(
      ctx(site({ sitemaps: found, refusedFetches: [WALL("sitemap", "/sitemap_index.xml")] })),
    );
    expect(checks[0]).toMatchObject({ status: "pass" });
  });
});

describe("ax/llms-txt", () => {
  test("a refused /llms.txt is not 'No /llms.txt found'", () => {
    const { checks } = llmsTxtRule.run(
      ctx(site({ llmsTxt: null, refusedFetches: [WALL("llms.txt", "/llms.txt")] })),
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "llms-txt", status: "info", value: "refused" });
    expect(checks[0]!.message).toContain("refused");
  });

  test("control: nothing refused and no row stored stays the generic not-checked", () => {
    const { checks } = llmsTxtRule.run(ctx(site({ llmsTxt: null })));
    expect(checks[0]).toMatchObject({ status: "info", value: "not-checked" });
  });
});

describe("ax/markdown-response", () => {
  test("a refused probe is not 'No Markdown response'", () => {
    const { checks } = markdownResponseRule.run(
      ctx(site({ markdownResponse: null, refusedFetches: [WALL("markdown", "/")] })),
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "markdown-response", status: "info", value: "refused" });
    expect(checks[0]!.message).not.toContain("No Markdown response");
  });
});

describe("crawl/robots-txt", () => {
  test("a refused robots.txt reports who refused it, never a missing file", () => {
    const { checks } = robotsTxtRule.run(
      ctx(site({ robotsTxt: UNREACHABLE_ROBOTS, refusedFetches: [WALL("robots.txt", "/robots.txt")] })),
    );

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "robots-txt-exists", status: "info" });
    expect(checks[0]!.value).toContain("refused");
    expect(checks[0]!.value).toContain("Cloudflare");
    expect(checks[0]!.value).toContain("unknown, not missing");
  });

  test("control: a 404 robots.txt (no recorded error) is still a failure", () => {
    const missing: RobotsTxtData = { ...UNREACHABLE_ROBOTS, errors: [] };
    const { checks } = robotsTxtRule.run(ctx(site({ robotsTxt: missing })));
    expect(checks[0]).toMatchObject({ status: "fail", message: "No robots.txt found" });
  });
});

describe("the runner skips root-resource rules when no page was fetched", () => {
  const probeRule: Rule = {
    meta: {
      id: "test/probe-reader",
      name: "Probe reader (test)",
      description: "reads a discovery probe",
      category: "ax",
      scope: "site",
      severity: "info",
      weight: 1,
      discoveryProbes: ["llms-txt"],
    },
    run: () => ({ checks: [{ name: "absent", status: "warn", message: "No file found" }] }),
  };
  const plainRule: Rule = {
    meta: {
      id: "test/plain-site",
      name: "Plain site rule (test)",
      description: "reads no root resource",
      category: "core",
      scope: "site",
      severity: "info",
      weight: 1,
    },
    run: () => ({ checks: [{ name: "plain", status: "warn", message: "A real finding" }] }),
  };
  const namespace: RuleNamespace = { name: "test", rules: [probeRule, plainRule] };

  function runner(): RuleRunner {
    return new RuleRunner({
      config: { rule_options: {}, rules: { enable: ["test/probe-reader", "test/plain-site", "crawl/sitemap-exists"] } },
      additionalNamespaces: [namespace],
    });
  }

  async function statusesFor(crawlLimits: SiteData["crawlLimits"]) {
    const result = await runner().runSiteRules(site({ sitemaps: NO_SITEMAPS, crawlLimits }));
    return Object.fromEntries(
      [...result.ruleResults].map(([id, r]) => [id, r.checks.map((c) => c.status)]),
    );
  }

  test("zero pages fetched: probe readers and the sitemap rule are skipped, others still run", async () => {
    const statuses = await statusesFor({ pagesCrawled: 0, maxPages: 100 });

    expect(statuses["test/probe-reader"]).toEqual(["skipped"]);
    expect(statuses["crawl/sitemap-exists"]).toEqual(["skipped"]);
    expect(statuses["test/plain-site"]).toEqual(["warn"]);
  });

  test("pages were fetched: nothing is skipped (the control)", async () => {
    const statuses = await statusesFor({ pagesCrawled: 12, maxPages: 100 });

    expect(statuses["test/probe-reader"]).toEqual(["warn"]);
    expect(statuses["crawl/sitemap-exists"]).toEqual(["fail"]);
  });

  test("a caller that never threaded crawlLimits skips nothing", async () => {
    const statuses = await statusesFor(undefined);
    expect(statuses["test/probe-reader"]).toEqual(["warn"]);
  });
});
