// core/canonical: a page that is not the home page whose canonical is the site root (#1685).
//
// The first half (`existing behaviour`) was written and run against the rule before the new check and pins
// what every other page gets, which must not change: one `canonical` check with the same status and message.

import { describe, expect, test } from "bun:test";

import type { RedirectChain } from "@squirrelscan/core-contracts";

import { canonicalRule, homepageCanonicalVerdict } from "../src/core/canonical";
import type { CheckResult, RuleContext } from "../src/types";

function chainTo(sourceUrl: string, finalUrl: string): RedirectChain {
  return {
    sourceUrl,
    finalUrl,
    hops: [
      { url: sourceUrl, statusCode: 301, type: "http" },
      { url: finalUrl, statusCode: 200, type: "http" },
    ],
    chainLength: 1,
    isLoop: false,
    endsInError: false,
    httpsToHttp: false,
    httpToHttps: false,
  };
}

function run(
  pageUrl: string,
  opts: { canonical?: string | null; linkHeader?: string; redirectTo?: string } = {},
): CheckResult[] {
  const ctx = {
    page: {
      url: pageUrl,
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: opts.linkHeader ? { link: opts.linkHeader } : {},
      ...(opts.redirectTo ? { redirectChain: chainTo(pageUrl, opts.redirectTo) } : {}),
    },
    parsed: { meta: { canonical: opts.canonical ?? null } },
    options: {},
  } as unknown as RuleContext;
  const result = canonicalRule.run(ctx);
  if (result instanceof Promise) throw new Error("core/canonical is sync");
  return result.checks;
}

const home = (checks: CheckResult[]) => checks.find((c) => c.name === "canonical-to-homepage");
const base = (checks: CheckResult[]) => checks.filter((c) => c.name === "canonical");

describe("existing behaviour of core/canonical (unchanged)", () => {
  test("a missing canonical warns", () => {
    const checks = run("https://example.com/a");
    expect(base(checks).map((c) => [c.status, c.message])).toEqual([["warn", "Missing canonical URL"]]);
    expect(home(checks)).toBeUndefined();
  });

  test("a relative canonical fails as not absolute", () => {
    expect(base(run("https://example.com/a", { canonical: "/a" })).map((c) => c.status)).toEqual(["fail"]);
  });

  test("a self canonical passes", () => {
    const checks = run("https://example.com/a", { canonical: "https://example.com/a" });
    expect(base(checks).map((c) => [c.status, c.message])).toEqual([["pass", "Self-referential canonical present"]]);
    expect(home(checks)).toBeUndefined();
  });

  test("a canonical to another URL is info, and nothing else", () => {
    const checks = run("https://example.com/a", { canonical: "https://example.com/b" });
    expect(checks.map((c) => [c.name, c.status])).toEqual([["canonical", "info"]]);
  });

  test("a canonical to another site's page is info, and nothing else", () => {
    const checks = run("https://example.com/a", { canonical: "https://other.example.org/a" });
    expect(checks.map((c) => [c.name, c.status])).toEqual([["canonical", "info"]]);
  });
});

describe("homepageCanonicalVerdict", () => {
  const table: Array<[string, string, string, "error" | "locale-home" | "none"]> = [
    ["a deep page canonicals to the root", "https://example.com/blog/post", "https://example.com/", "error"],
    ["a page at one segment canonicals to the root", "https://example.com/about", "https://example.com/", "error"],
    ["the root without a trailing slash is the root", "https://example.com/about", "https://example.com", "error"],
    ["/index.html is the root", "https://example.com/about", "https://example.com/index.html", "error"],
    ["www canonical of a bare-host page is the same site's root", "https://example.com/about", "https://www.example.com/", "error"],
    ["bare canonical of a www page is the same site's root", "https://www.example.com/about", "https://example.com/", "error"],
    ["a relative root canonical resolves against the page", "https://example.com/about", "/", "error"],
    ["the fragment is ignored", "https://example.com/about", "https://example.com/#top", "error"],
    ["http and https of the root are the same root", "https://example.com/about", "http://example.com/", "error"],
    ["the home page with a self canonical", "https://example.com/", "https://example.com/", "none"],
    ["the home page without a slash", "https://example.com", "https://example.com/", "none"],
    ["/index.html with a canonical to /", "https://example.com/index.html", "https://example.com/", "none"],
    ["/ with a canonical to /index.html", "https://example.com/", "https://example.com/index.html", "none"],
    ["/index.php with a canonical to /", "https://example.com/index.php", "https://example.com/", "none"],
    ["/index.php is the root", "https://example.com/about", "https://example.com/index.php", "error"],
    ["/index.htm with a canonical to /", "https://example.com/index.htm", "https://example.com/", "none"],
    ["/index.htm is the root", "https://example.com/about", "https://example.com/index.htm", "error"],
    ["/index.asp with a canonical to /", "https://example.com/index.asp", "https://example.com/", "none"],
    ["/index.asp is the root", "https://example.com/about", "https://example.com/index.asp", "error"],
    ["/index.aspx with a canonical to /", "https://example.com/index.aspx", "https://example.com/", "none"],
    ["/index.aspx is the root", "https://example.com/about", "https://example.com/index.aspx", "error"],
    ["/default.asp with a canonical to /", "https://example.com/default.asp", "https://example.com/", "none"],
    ["/default.asp is the root", "https://example.com/about", "https://example.com/default.asp", "error"],
    ["/default.aspx with a canonical to /", "https://example.com/default.aspx", "https://example.com/", "none"],
    ["/default.aspx is the root", "https://example.com/about", "https://example.com/default.aspx", "error"],
    ["/default.htm with a canonical to /", "https://example.com/default.htm", "https://example.com/", "none"],
    ["/default.htm is the root", "https://example.com/about", "https://example.com/default.htm", "error"],
    ["/default.html with a canonical to /", "https://example.com/default.html", "https://example.com/", "none"],
    ["/default.html is the root", "https://example.com/about", "https://example.com/default.html", "error"],
    ["/INDEX.PHP with a canonical to /", "https://example.com/INDEX.PHP", "https://example.com/", "none"],
    ["/INDEX.PHP is the root", "https://example.com/about", "https://example.com/INDEX.PHP", "error"],
    ["a similar name is not a home file", "https://example.com/index.json", "https://example.com/", "error"],
    ["a home file in a subdirectory is not the root", "https://example.com/blog/index.php", "https://example.com/", "error"],
    ["/home with a canonical to /", "https://example.com/home", "https://example.com/", "none"],
    ["/home is the root", "https://example.com/about", "https://example.com/home", "error"],
    ["/home/ with a canonical to /", "https://example.com/home/", "https://example.com/", "none"],
    ["/home/ is the root", "https://example.com/about", "https://example.com/home/", "error"],
    ["/index with a canonical to /", "https://example.com/index", "https://example.com/", "none"],
    ["/index is the root", "https://example.com/about", "https://example.com/index", "error"],
    ["/HOME with a canonical to /", "https://example.com/HOME", "https://example.com/", "none"],
    ["/HOME is the root", "https://example.com/about", "https://example.com/HOME", "error"],
    ["/home.html with a canonical to /", "https://example.com/home.html", "https://example.com/", "none"],
    ["/home.html is the root", "https://example.com/about", "https://example.com/home.html", "error"],
    ["/home.php with a canonical to /", "https://example.com/home.php", "https://example.com/", "none"],
    ["/home.php is the root", "https://example.com/about", "https://example.com/home.php", "error"],
    ["/Home.aspx with a canonical to /", "https://example.com/Home.aspx", "https://example.com/", "none"],
    ["/Home.aspx is the root", "https://example.com/about", "https://example.com/Home.aspx", "error"],
    ["/homepage-design is not a home page", "https://example.com/homepage-design", "https://example.com/", "error"],
    ["/home/pricing is not a home page", "https://example.com/home/pricing", "https://example.com/", "error"],
    ["/homes is not a home page", "https://example.com/homes", "https://example.com/", "error"],
    ["/index/extra is not a home page", "https://example.com/index/extra", "https://example.com/", "error"],
    ["/home.html/x is not a home page", "https://example.com/home.html/x", "https://example.com/", "error"],
    ["the home page with a tracking query", "https://example.com/?utm_source=x", "https://example.com/", "none"],
    ["www home page with a bare canonical", "https://www.example.com/", "https://example.com/", "none"],
    ["a canonical to another page", "https://example.com/a", "https://example.com/b", "none"],
    ["a canonical to a different site's root", "https://example.com/a", "https://other.example.org/", "none"],
    ["a subdomain is a different site", "https://blog.example.com/a", "https://example.com/", "none"],
    ["a root with a query is a different URL (/?page_id=5)", "https://example.com/about", "https://example.com/?page_id=5", "none"],
    ["a locale home canonicals to the root", "https://example.com/en/", "https://example.com/", "locale-home"],
    ["a locale home without a slash", "https://example.com/de", "https://example.com/", "locale-home"],
    ["a regional locale home", "https://example.com/pt-br/", "https://example.com/", "locale-home"],
    ["a page inside a locale is not a locale home", "https://example.com/en/about", "https://example.com/", "error"],
    ["a three-letter segment is not a locale", "https://example.com/faq/", "https://example.com/", "error"],
    ["an unparseable canonical", "https://example.com/a", "http://", "none"],
    ["a non-http canonical", "https://example.com/a", "mailto:a@example.com", "none"],
  ];
  for (const [name, page, canonical, expected] of table) {
    test(`${name}: ${expected}`, () => {
      expect(homepageCanonicalVerdict(page, canonical)).toBe(expected);
    });
  }
});

describe("canonical-to-homepage in the rule", () => {
  test("a home page served at /index.php with a canonical to / is not flagged", () => {
    const checks = run("https://example.com/index.php", { canonical: "https://example.com/" });
    expect(home(checks)).toBeUndefined();
  });

  test("a page whose tag canonical is the site root fails, naming the page and the canonical", () => {
    const check = home(run("https://example.com/pricing", { canonical: "https://example.com/" }));
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("https://example.com/pricing");
    expect(check?.message).toContain("https://example.com/");
    expect(check?.value).toBe("https://example.com/");
    expect(check?.details).toMatchObject({ pageUrl: "https://example.com/pricing", canonical: "https://example.com/", source: "tag" });
  });

  test("the existing canonical check is still there beside it", () => {
    const checks = run("https://example.com/pricing", { canonical: "https://example.com/" });
    expect(base(checks).map((c) => c.status)).toEqual(["info"]);
  });

  test("the home page with a self canonical is not flagged", () => {
    expect(home(run("https://example.com/", { canonical: "https://example.com/" }))).toBeUndefined();
  });

  test("a locale home page whose canonical is the root is a warning, not an error", () => {
    expect(home(run("https://example.com/en/", { canonical: "https://example.com/" }))?.status).toBe("warn");
  });

  test("a page that redirects to the home page is the home page, so it is not flagged", () => {
    const checks = run("https://example.com/old-home", {
      canonical: "https://example.com/",
      redirectTo: "https://example.com/",
    });
    expect(home(checks)).toBeUndefined();
  });

  test("a redirect to a deep page is judged by where it ended", () => {
    const checks = run("https://example.com/old", {
      canonical: "https://example.com/",
      redirectTo: "https://example.com/new",
    });
    expect(home(checks)?.status).toBe("fail");
    expect(home(checks)?.details).toMatchObject({ pageUrl: "https://example.com/new" });
  });

  test("the Link header canonical is treated like the tag", () => {
    const check = home(
      run("https://example.com/pricing", {
        canonical: "https://example.com/pricing",
        linkHeader: '<https://example.com/>; rel="canonical"',
      }),
    );
    expect(check?.status).toBe("fail");
    expect(check?.details).toMatchObject({ source: "header" });
  });

  test("a header-only canonical to the root fails too, beside the missing-tag warning", () => {
    const checks = run("https://example.com/pricing", { linkHeader: '<https://example.com/>; rel="canonical"' });
    expect(home(checks)?.status).toBe("fail");
    expect(base(checks).map((c) => c.status)).toEqual(["warn"]);
  });

  test("a header canonical to another page is not flagged", () => {
    expect(home(run("https://example.com/a", { canonical: "https://example.com/a", linkHeader: '<https://example.com/b>; rel="canonical"' }))).toBeUndefined();
  });

  test("when the tag and the header both name the root, it is reported once", () => {
    const checks = run("https://example.com/a", {
      canonical: "https://example.com/",
      linkHeader: '<https://example.com/>; rel="canonical"',
    });
    expect(checks.filter((c) => c.name === "canonical-to-homepage")).toHaveLength(1);
  });
});

describe("declared severity agrees with the statuses the rule emits (#1746)", () => {
  test("a rule that emits fail is declared error", () => {
    const pages: Array<[string, { canonical?: string | null }]> = [
      ["https://example.com/a", { canonical: "/a" }],
      ["https://example.com/a", { canonical: "https://example.com/" }],
      ["https://example.com/a", { canonical: "http://[bad" }],
    ];
    const emitsFail = pages.some(([url, opts]) => run(url, opts).some((c) => c.status === "fail"));
    expect(emitsFail).toBe(true);
    expect(canonicalRule.meta.severity).toBe("error");
  });
});
