// eeat/privacy-policy: a policy that is linked but was not crawled (pub#672).
//
// The reporter's three-origin fixture, as site data: a genuinely missing policy,
// a linked policy the crawl fetched, and the same linked policy excluded from the
// crawl (`[crawler] exclude = ["/policies/**"]`). The excluded case used to get
// "No Privacy Policy page found" and advice to create one.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SitemapUrlStatusData } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { privacyPolicyRule } from "../src/eeat/privacy-policy";
import type { ParsedPage, RuleContext, SiteData } from "../src/types";

const ORIGIN = "http://127.0.0.1:8792";
const POLICY = `${ORIGIN}/policies/privacy-policy`;
const LINK = '<a href="/policies/privacy-policy">Privacy Policy</a>';

/** The reporter's fixture page: same markup for the storefront and the policy. */
function fixturePage(title: string, footer: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>This is the ${title} page of an isolated test fixture.</p></main><footer>${footer}</footer></body></html>`;
}

function siteCtx(
  pagesHtml: { url: string; html: string; finalUrl?: string }[],
  linkTargetStatuses?: SitemapUrlStatusData[],
): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}),
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: { url: pages[0]?.url ?? ORIGIN, html: "", statusCode: 200, loadTime: 0, headers: {} },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: {
      baseUrl: ORIGIN,
      pages,
      robotsTxt: null,
      sitemaps: null,
      ...(linkTargetStatuses ? { linkTargetStatuses } : {}),
    },
    options: {},
  };
}

function run(ctx: RuleContext): CheckResult[] {
  return privacyPolicyRule.run(ctx).checks;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

const home = (footer: string) => ({
  url: `${ORIGIN}/`,
  html: fixturePage("Example storefront", footer),
});

describe("eeat/privacy-policy: the reporter's three origins (pub#672)", () => {
  test("missing: no policy and no link still warns with the create advice", () => {
    const checks = run(siteCtx([home("")]));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: "privacy-policy",
      status: "warn",
      message: "No Privacy Policy page found",
      value: "Create /privacy-policy page",
    });
  });

  test("allowed: the crawled, linked policy passes", () => {
    const checks = run(
      siteCtx([home(LINK), { url: POLICY, html: fixturePage("Privacy Policy", "") }]),
    );
    expect(check(checks, "privacy-policy")).toMatchObject({
      status: "pass",
      message: "Privacy Policy page exists",
      value: POLICY,
    });
    // The storefront links it and the policy page does not link itself.
    expect(check(checks, "privacy-linked")).toMatchObject({
      status: "info",
      message: "Privacy policy linked from 50% of pages",
    });
  });

  test("excluded: a linked policy the crawl did not fetch is info, not create advice", () => {
    const checks = run(siteCtx([home(LINK)]));
    expect(check(checks, "privacy-policy")).toMatchObject({
      status: "info",
      message: "Privacy Policy linked but not crawled",
      value: POLICY,
      details: { linkedFrom: `${ORIGIN}/` },
    });
    expect(checks.some((c) => c.value === "Create /privacy-policy page")).toBe(false);
    // The footer link is on every crawled page, so coverage still reads 100%.
    expect(check(checks, "privacy-linked")).toMatchObject({
      status: "pass",
      message: "Privacy policy linked from 100% of pages",
    });
  });
});

describe("eeat/privacy-policy: what the link probe recorded", () => {
  test("a probed 404 warns that the link is broken", () => {
    const checks = run(siteCtx([home(LINK)], [{ url: POLICY, status: 404, error: null }]));
    expect(check(checks, "privacy-policy")).toMatchObject({
      status: "warn",
      message: "Privacy Policy link returns 404",
      value: POLICY,
      details: { probedStatus: 404 },
    });
  });

  test("a probed 200 is still only info: a status is not proof of a policy", () => {
    const checks = run(siteCtx([home(LINK)], [{ url: POLICY, status: 200, error: null }]));
    expect(check(checks, "privacy-policy")).toMatchObject({
      status: "info",
      message: "Privacy Policy linked but not crawled",
      details: { probedStatus: 200 },
    });
  });

  test("a probed 403 or a rate limit is not read as broken", () => {
    for (const probe of [
      { url: POLICY, status: 403, error: null },
      { url: POLICY, status: 429, error: null, rateLimited: true },
    ]) {
      const checks = run(siteCtx([home(LINK)], [probe]));
      expect(check(checks, "privacy-policy")?.status).toBe("info");
    }
  });

  test("the probe's URL matches the link with a trailing slash", () => {
    const checks = run(siteCtx([home(LINK)], [{ url: `${POLICY}/`, status: 410, error: null }]));
    expect(check(checks, "privacy-policy")?.message).toBe("Privacy Policy link returns 410");
  });
});

describe("eeat/privacy-policy: which links count", () => {
  test("a link recognised only by its anchor text is info, with no slug coverage check", () => {
    const checks = run(siteCtx([home('<a href="/rechtliches/dsgvo">Datenschutz</a>')]));
    expect(check(checks, "privacy-policy")).toMatchObject({
      status: "info",
      message: "Privacy Policy linked but not crawled",
      value: `${ORIGIN}/rechtliches/dsgvo`,
    });
    expect(check(checks, "privacy-linked")).toBeUndefined();
  });

  test("a slug link anywhere wins over an earlier text-only link", () => {
    const checks = run(
      siteCtx([
        home('<a href="/cookies">Privacy settings</a>'),
        { url: `${ORIGIN}/shop`, html: fixturePage("Shop", LINK) },
      ]),
    );
    expect(check(checks, "privacy-policy")?.value).toBe(POLICY);
  });

  test("a linked page the crawl DID fetch is not reported as uncrawled", () => {
    // Crawled, but neither its slug nor its title reads as a privacy policy:
    // the page was checked, so the missing-policy advice stands as before.
    const checks = run(
      siteCtx([
        home('<a href="/rechtliches">Datenschutz</a>'),
        { url: `${ORIGIN}/rechtliches`, html: fixturePage("Rechtliches", "") },
      ]),
    );
    expect(check(checks, "privacy-policy")?.message).toBe("No Privacy Policy page found");
  });

  test("a target reached through a crawled redirect counts as crawled", () => {
    const checks = run(
      siteCtx([
        home('<a href="/old-privacy">Privacy</a>'),
        {
          url: `${ORIGIN}/legal`,
          finalUrl: `${ORIGIN}/old-privacy`,
          html: fixturePage("Legal", ""),
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.message).toBe("No Privacy Policy page found");
  });

  test("mailto: and javascript: links are never a policy page", () => {
    const checks = run(
      siteCtx([
        home(
          '<a href="mailto:privacy@example.com">Privacy</a><a href="javascript:void(0)">Privacy</a>',
        ),
      ]),
    );
    expect(check(checks, "privacy-policy")?.message).toBe("No Privacy Policy page found");
  });
});
