// security/version-disclosure — version numbers in Server, X-Powered-By, X-AspNet-Version,
// X-AspNetMvc-Version and X-Generator (#713).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { versionDisclosureRule } from "../src/security/version-disclosure";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

type Pages = SiteData["pages"];

/** A page from a current crawl: the version headers were recorded. */
function page(url: string, headers: Record<string, string>): Pages[number] {
  return { url, statusCode: 200, parsed: {} as ParsedPage, headers, versionHeadersRecorded: true };
}

/** A page record stored before the version headers were recorded. */
function oldPage(url: string, headers: Record<string, string>): Pages[number] {
  return { url, statusCode: 200, parsed: {} as ParsedPage, headers };
}

function run(pages: Pages): CheckResult[] {
  const ctx: RuleContext = {
    page: { url: "https://example.com/", html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: {} as ParsedPage,
    site: {
      baseUrl: "https://example.com",
      pages,
      robotsTxt: null,
      sitemaps: null,
      wellKnown: null,
    },
    options: {},
  };
  return versionDisclosureRule.run(ctx).checks;
}

const warns = (checks: CheckResult[]) => checks.filter((c) => c.status === "warn");

describe("security/version-disclosure", () => {
  test("no pages: skipped", () => {
    expect(run([])[0]?.status).toBe("skipped");
  });

  test("Server with a version warns, naming the header and value", () => {
    const checks = warns(run([page("https://example.com/", { server: "Apache/2.4.41 (Ubuntu)" })]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.message).toContain("Server");
    expect(checks[0]?.message).toContain("Apache/2.4.41 (Ubuntu)");
  });

  test("X-Powered-By with a version warns", () => {
    const checks = warns(run([page("https://example.com/", { "x-powered-by": "PHP/7.4.3" })]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.message).toContain("X-Powered-By");
    expect(checks[0]?.message).toContain("PHP/7.4.3");
  });

  test("ASP.NET version headers warn, including a bare version value", () => {
    const checks = warns(
      run([
        page("https://example.com/", {
          "x-aspnet-version": "4.0.30319",
          "x-aspnetmvc-version": "5.2",
        }),
      ]),
    );
    expect(checks.map((c) => c.value).sort()).toEqual(["4.0.30319", "5.2"]);
  });

  test("X-Generator with a version warns", () => {
    const checks = warns(run([page("https://example.com/", { "x-generator": "WordPress 6.2.1" })]));
    expect(checks).toHaveLength(1);
  });

  test("a product name with no version is not reported", () => {
    const checks = run([
      page("https://example.com/", { server: "nginx", "x-powered-by": "Express" }),
    ]);
    expect(warns(checks)).toHaveLength(0);
    expect(checks.find((c) => c.status === "pass")).toBeDefined();
  });

  test("cloudflare and other edge names alone are not reported", () => {
    expect(warns(run([page("https://example.com/", { server: "cloudflare" })]))).toHaveLength(0);
  });

  test("a single-number generator (Drupal 9) is not a version under the strict pattern", () => {
    expect(warns(run([page("https://example.com/", { "x-generator": "Drupal 9" })]))).toHaveLength(
      0,
    );
  });

  test("one finding per header value across the site, listing every page it was seen on", () => {
    const checks = warns(
      run([
        page("https://example.com/", { server: "nginx/1.18.0" }),
        page("https://example.com/about", { server: "nginx/1.18.0" }),
        page("https://example.com/blog", { server: "nginx/1.18.0" }),
      ]),
    );
    expect(checks).toHaveLength(1);
    // In the standard item field, so the report lists the pages.
    expect(checks[0]?.items).toHaveLength(1);
    expect(checks[0]?.items?.[0]?.sourcePages).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/blog",
    ]);
    expect(checks[0]?.details).toMatchObject({ header: "Server", pageCount: 3 });
  });

  test("a site-wide header on many pages is one finding listing each page once", () => {
    const pages = Array.from({ length: 300 }, (_, n) =>
      page(`https://example.com/p${n}`, { server: "nginx/1.18.0" }),
    );
    const checks = warns(run([...pages, ...pages]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.items?.[0]?.sourcePages).toHaveLength(300);
  });

  test("a huge header value is capped in the message, kept whole in value", () => {
    const value = `Apache/2.4.41 ${"x".repeat(5000)}`;
    const checks = warns(run([page("https://example.com/", { server: value })]));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.message.length).toBeLessThan(200);
    expect(checks[0]?.message.endsWith("...")).toBe(true);
    expect(checks[0]?.value).toBe(value);
  });

  test("page records stored before the version headers: not checked, never a pass", () => {
    const checks = run([oldPage("https://example.com/", { server: "cloudflare" })]);
    expect(checks.find((c) => c.status === "pass")).toBeUndefined();
    const skipped = checks.find((c) => c.name === "version-disclosure-unrecorded");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.message).toContain("--refresh");
  });

  test("on stored records, a versioned Server header is still reported", () => {
    const checks = run([oldPage("https://example.com/", { server: "nginx/1.18.0" })]);
    expect(warns(checks)).toHaveLength(1);
    expect(checks.find((c) => c.name === "version-disclosure-unrecorded")?.status).toBe("skipped");
  });

  test("two different values for the same header give two findings", () => {
    const checks = warns(
      run([
        page("https://example.com/", { server: "nginx/1.18.0" }),
        page("https://example.com/app", { server: "nginx/1.20.1" }),
      ]),
    );
    expect(checks).toHaveLength(2);
  });

  test("no version on any page passes", () => {
    const checks = run([page("https://example.com/", { server: "cloudflare" })]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe("pass");
  });
});
