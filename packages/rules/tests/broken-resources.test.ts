// reliability/broken-resources - scripts, stylesheets and fonts that fail to load (#703).

import { describe, expect, test } from "bun:test";

import type {
  CheckResult,
  ResourceSizeData,
  ScriptContentData,
} from "@squirrelscan/core-contracts";
import {
  ASSET_FETCH_REFUSED_ERROR,
  ASSET_FETCH_SKIPPED_ERROR,
} from "@squirrelscan/utils/constants";

import { getCategoryGroup, getCategoryName, CATEGORY_CODES } from "../src/categories";
import { loadAllRules } from "../src/loader";
import { brokenResourcesRule } from "../src/reliability/broken-resources";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const PAGE = "https://example.com/";

function script(overrides: Partial<ScriptContentData> = {}): ScriptContentData {
  return {
    url: "https://example.com/app.js",
    status: 200,
    error: null,
    contentType: "application/javascript",
    sizeBytes: 100,
    content: null,
    sourcePages: [PAGE],
    ...overrides,
  };
}

function sheet(overrides: Partial<ResourceSizeData> = {}): ResourceSizeData {
  return {
    url: "https://example.com/app.css",
    status: 200,
    error: null,
    contentType: "text/css",
    sizeBytes: 100,
    sourcePages: [PAGE],
    ...overrides,
  };
}

interface Measured {
  scripts?: ScriptContentData[];
  css?: ResourceSizeData[];
  fonts?: ResourceSizeData[];
  images?: ResourceSizeData[];
  external?: {
    scripts?: ScriptContentData[];
    css?: ResourceSizeData[];
    fonts?: ResourceSizeData[];
  };
  dropped?: SiteData["assetCapDropped"];
  baseUrl?: string;
}

function ctx(m: Measured): RuleContext {
  const site: SiteData = {
    baseUrl: m.baseUrl ?? "https://example.com",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
    resourceSizes:
      m.css === undefined && m.fonts === undefined && m.images === undefined
        ? undefined
        : {
            css: m.css ?? [],
            images: m.images ?? [],
            ...(m.fonts !== undefined ? { fonts: m.fonts } : {}),
          },
    ...(m.scripts !== undefined ? { scripts: m.scripts } : {}),
    externalAssets: {
      scripts: m.external?.scripts ?? [],
      css: m.external?.css ?? [],
      fonts: m.external?.fonts ?? [],
    },
    ...(m.dropped !== undefined ? { assetCapDropped: m.dropped } : {}),
  };
  return {
    page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site,
    options: {},
  };
}

function run(m: Measured): CheckResult[] {
  return brokenResourcesRule.run(ctx(m)).checks as CheckResult[];
}

function named(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

describe("reliability category wiring", () => {
  test("is registered as a category in the Performance group", () => {
    expect(CATEGORY_CODES).toContain("reliability");
    expect(getCategoryName("reliability")).toBe("Reliability");
    expect(getCategoryGroup("reliability")).toBe("performance");
  });

  test("the rule is loaded by the rule loader", () => {
    expect(loadAllRules().has("reliability/broken-resources")).toBe(true);
  });
});

describe("reliability/broken-resources", () => {
  test("meta: reliability category, site scope, error severity", () => {
    expect(brokenResourcesRule.meta.id).toBe("reliability/broken-resources");
    expect(brokenResourcesRule.meta.category).toBe("reliability");
    expect(brokenResourcesRule.meta.scope).toBe("site");
    expect(brokenResourcesRule.meta.severity).toBe("error");
  });

  test("first-party script answering 404 is an error finding naming URL, status and pages", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/app.js",
          status: 404,
          error: "HTTP 404",
          sourcePages: ["https://example.com/", "https://example.com/about"],
        }),
      ],
      css: [],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.status).toBe("fail");
    expect(fail?.items).toHaveLength(1);
    const item = fail!.items![0]!;
    expect(item.id).toBe("https://example.com/app.js");
    expect(item.label).toContain("HTTP 404");
    expect(item.sourcePages).toEqual(["https://example.com/", "https://example.com/about"]);
  });

  test("first-party stylesheet answering 500 is an error finding", () => {
    const checks = run({
      scripts: [],
      css: [sheet({ url: "https://example.com/site.css", status: 500, error: "HTTP 500" })],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.status).toBe("fail");
    expect(fail?.items?.[0]?.id).toBe("https://example.com/site.css");
    expect(fail?.items?.[0]?.label).toContain("HTTP 500");
  });

  test("a bare 503 on a first-party stylesheet is broken, not unverified", () => {
    const checks = run({
      scripts: [],
      css: [sheet({ url: "https://example.com/site.css", status: 503, error: "HTTP 503" })],
      fonts: [],
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
    expect(named(checks, "unverified-resources")).toBeUndefined();
  });

  test("first-party subdomain counts as first-party", () => {
    const checks = run({
      scripts: [script({ url: "https://cdn.example.com/app.js", status: 404, error: "HTTP 404" })],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
  });

  // The collector files these under the third-party lists (they are not the
  // site's host or a subdomain of it); the rule still owns them by registrable domain.
  test("a site on www owns its apex: apex script answering 404 is an error", () => {
    const checks = run({
      baseUrl: "https://www.example.com",
      scripts: [],
      css: [],
      fonts: [],
      external: {
        scripts: [script({ url: "https://example.com/app.js", status: 404, error: "HTTP 404" })],
      },
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
    expect(named(checks, "broken-resources")?.items?.[0]?.id).toBe("https://example.com/app.js");
    expect(named(checks, "unreachable-resources")).toBeUndefined();
  });

  test("a site on www owns a cdn subdomain: cdn stylesheet answering 500 is an error", () => {
    const checks = run({
      baseUrl: "https://www.example.com",
      scripts: [],
      css: [],
      fonts: [],
      external: {
        css: [sheet({ url: "https://cdn.example.com/site.css", status: 500, error: "HTTP 500" })],
      },
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
    expect(named(checks, "unreachable-resources")).toBeUndefined();
  });

  test("a host with no registrable domain still owns its subdomains (localhost)", () => {
    const checks = run({
      baseUrl: "http://localhost:3000",
      scripts: [],
      css: [],
      fonts: [],
      external: {
        scripts: [
          script({ url: "http://assets.localhost:3000/app.js", status: 404, error: "HTTP 404" }),
        ],
      },
    });
    expect(named(checks, "broken-resources")?.status).toBe("fail");
  });

  test("a look-alike host or another tenant of a hosting suffix stays third-party", () => {
    const lookAlike = run({
      baseUrl: "https://www.example.com",
      scripts: [],
      css: [],
      fonts: [],
      external: {
        scripts: [
          script({ url: "https://example.com.evil.net/a.js", status: 404, error: "HTTP 404" }),
          script({ url: "https://notexample.com/b.js", status: 404, error: "HTTP 404" }),
        ],
      },
    });
    expect(named(lookAlike, "broken-resources")).toBeUndefined();
    expect(named(lookAlike, "unreachable-resources")?.items).toHaveLength(2);

    const tenant = run({
      baseUrl: "https://acme.vercel.app",
      scripts: [],
      css: [],
      fonts: [],
      external: {
        scripts: [script({ url: "https://other.vercel.app/a.js", status: 404, error: "HTTP 404" })],
      },
    });
    expect(named(tenant, "broken-resources")).toBeUndefined();
    expect(named(tenant, "unreachable-resources")?.status).toBe("warn");
  });

  test("third-party script answering 404 is a warning, not an error", () => {
    const checks = run({
      css: [],
      fonts: [],
      external: {
        scripts: [
          script({ url: "https://tracker.other.net/t.js", status: 404, error: "HTTP 404" }),
        ],
      },
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    const warn = named(checks, "unreachable-resources");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.id).toBe("https://tracker.other.net/t.js");
  });

  test("third-party stylesheet answering 500 is a warning", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [],
      external: {
        css: [sheet({ url: "https://cdn.other.net/x.css", status: 500, error: "HTTP 500" })],
      },
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")?.status).toBe("warn");
  });

  test("font answering 404 is a warning, not an error", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [sheet({ url: "https://example.com/fonts/a.woff2", status: 404, error: "HTTP 404" })],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")?.status).toBe("warn");
  });

  test("network-level failures (DNS, TLS, timeout) are warnings", () => {
    const checks = run({
      scripts: [script({ url: "https://example.com/slow.js", status: null, error: "timeout" })],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    const warn = named(checks, "unreachable-resources");
    expect(warn?.status).toBe("warn");
    expect(warn?.items?.[0]?.label).toContain("timeout");
  });

  test("429, 430 and 503 with Retry-After (rateLimited) are unverified info, never broken", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/a.js",
          status: 429,
          error: "HTTP 429",
          rateLimited: true,
        }),
        script({
          url: "https://example.com/b.js",
          status: 430,
          error: "HTTP 430",
          rateLimited: true,
        }),
        script({
          url: "https://example.com/c.js",
          status: 503,
          error: "HTTP 503",
          rateLimited: true,
        }),
      ],
      css: [
        sheet({
          url: "https://example.com/d.css",
          status: 503,
          error: "HTTP 503",
          rateLimited: true,
        }),
      ],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unreachable-resources")).toBeUndefined();
    const unverified = named(checks, "unverified-resources");
    expect(unverified?.status).toBe("info");
    expect(unverified?.items).toHaveLength(4);
  });

  test("a WAF challenge on a first-party script is unverified info, not an error", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/app.js",
          status: 403,
          error: "HTTP 403",
          wafBlocked: true,
        }),
      ],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    expect(named(checks, "unverified-resources")?.status).toBe("info");
    expect(named(checks, "unverified-resources")?.items?.[0]?.meta).toMatchObject({
      wafBlocked: true,
    });
  });

  test("a 401 from a host the custom headers were withheld from is unverified and names the host (#732)", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://cdn.example.com/app.js",
          status: 401,
          error: "HTTP 401",
          headersWithheld: true,
        }),
      ],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeUndefined();
    const unverified = named(checks, "unverified-resources");
    expect(unverified?.status).toBe("info");
    expect(unverified?.message).toContain("cdn.example.com");
    expect(unverified?.message).toContain("--header-host");
  });

  test("a 404 from a host the headers were withheld from is still broken (#732)", () => {
    const checks = run({
      scripts: [
        script({
          url: "https://cdn.example.com/gone.js",
          status: 404,
          error: "HTTP 404",
          headersWithheld: true,
        }),
      ],
      css: [],
      fonts: [],
    });
    expect(named(checks, "broken-resources")).toBeDefined();
  });

  test("one URL referenced from five pages yields one finding listing all five pages", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => `https://example.com/p${n}`);
    const checks = run({
      scripts: [
        script({
          url: "https://example.com/gone.js",
          status: 404,
          error: "HTTP 404",
          sourcePages: pages,
        }),
      ],
      css: [],
      fonts: [],
    });
    const fail = named(checks, "broken-resources");
    expect(fail?.items).toHaveLength(1);
    expect(fail?.items?.[0]?.sourcePages).toEqual(pages);
  });

  test("a fully healthy set passes", () => {
    const checks = run({
      scripts: [script()],
      css: [sheet()],
      fonts: [sheet({ url: "https://example.com/f.woff2" })],
    });
    expect(named(checks, "broken-resources")?.status).toBe("pass");
    expect(named(checks, "unchecked-resources")).toBeUndefined();
  });

  test("skipped fetches (asset budget) make the result partial, not a pass", () => {
    const checks = run({
      scripts: [
        script({ url: "https://example.com/ok.js" }),
        script({
          url: "https://example.com/late.js",
          status: null,
          error: ASSET_FETCH_SKIPPED_ERROR,
        }),
      ],
      css: [],
      fonts: [],
    });
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain("Partial check");
    expect(partial?.message).toContain("1 referenced resource(s) were not fetched");
    expect(named(checks, "broken-resources")?.message).toBe(
      "No broken resources among the 1 checked",
    );
  });

  test("401 to the credential-less third-party probe is unverified; 401 on the site's own host is broken", () => {
    const checks = run({
      baseUrl: "https://www.example.com",
      scripts: [script({ url: "https://www.example.com/own.js", status: 401, error: "HTTP 401" })],
      css: [],
      fonts: [],
      external: {
        // A sibling subdomain the collector files with third parties: first-party
        // by registrable domain, but probed without the audit's credentials.
        css: [sheet({ url: "https://static.example.com/a.css", status: 401, error: "HTTP 401" })],
      },
    });
    expect(named(checks, "broken-resources")?.items?.map((i) => i.id)).toEqual([
      "https://www.example.com/own.js",
    ]);
    expect(named(checks, "unverified-resources")?.items?.map((i) => i.id)).toEqual([
      "https://static.example.com/a.css",
    ]);
  });

  test("401 from a true third party fails for visitors too, so it stays a warning", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [],
      external: {
        scripts: [script({ url: "https://kit.vendor.net/k.js", status: 401, error: "HTTP 401" })],
      },
    });
    expect(named(checks, "unreachable-resources")?.items?.map((i) => i.id)).toEqual([
      "https://kit.vendor.net/k.js",
    ]);
    expect(named(checks, "unverified-resources")).toBeUndefined();
  });

  test("a third-party URL the egress policy refused is not checked, never broken", () => {
    const checks = run({
      scripts: [script({ url: "https://example.com/ok.js" })],
      css: [],
      fonts: [],
      external: {
        scripts: [
          script({
            url: "http://169.254.169.254/latest/meta-data/x.js",
            status: null,
            error: ASSET_FETCH_REFUSED_ERROR,
          }),
        ],
      },
    });
    expect(named(checks, "unreachable-resources")).toBeUndefined();
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain(
      "1 referenced resource(s) were not requested (a private, loopback or metadata address, or another site in an offline audit)",
    );
    expect(partial?.details).toMatchObject({ refused: 1 });
    expect(named(checks, "broken-resources")?.message).toBe(
      "No broken resources among the 1 checked",
    );
  });

  test("URLs dropped by the asset fetch cap make the result partial and say so", () => {
    const checks = run({
      scripts: [script({ url: "https://example.com/ok.js" })],
      css: [],
      fonts: [],
      dropped: { scripts: 3 },
    });
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain(
      "3 referenced resource(s) were not fetched (asset fetch cap)",
    );
    expect(named(checks, "broken-resources")?.message).toBe(
      "No broken resources among the 1 checked",
    );
  });

  test("a resource kind absent from the crawl is reported as not measured", () => {
    const checks = run({ scripts: [script()] });
    const partial = named(checks, "unchecked-resources");
    expect(partial?.status).toBe("info");
    expect(partial?.message).toContain("stylesheets, fonts were not measured");
  });

  test("broken images are left to images/broken-images", () => {
    const checks = run({
      scripts: [],
      css: [],
      fonts: [],
      images: [
        {
          url: "https://example.com/missing.png",
          status: 404,
          error: "HTTP 404",
          contentType: null,
          sizeBytes: null,
          sourcePages: [PAGE],
        },
      ],
    });
    expect(checks.some((c) => c.items?.some((i) => i.id.includes("missing.png")))).toBe(false);
  });

  test("site data missing is skipped", () => {
    const result = brokenResourcesRule.run({
      page: { url: PAGE, html: "", statusCode: 200, loadTime: 0, headers: {} },
      parsed: {} as ParsedPage,
      options: {},
    } as unknown as RuleContext);
    expect(result.checks[0]?.status).toBe("skipped");
  });
});
