// eeat/about-page and eeat/contact-page: a page that is linked but was not
// crawled (pub#740), the same fix as eeat/privacy-policy (pub#672). Each rule
// gets the three cases: genuinely missing, linked and crawled, linked but
// excluded from the crawl.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SitemapUrlStatusData } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { aboutPageRule } from "../src/eeat/about-page";
import { contactPageRule } from "../src/eeat/contact-page";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

const ORIGIN = "https://shop.example";

// >=200 words so the about-page rule reports "substantial content".
const FILLER = `<p>${Array.from({ length: 220 }, (_, i) => `word${i}`).join(" ")}</p>`;

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
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

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks;
}

const cases = [
  {
    rule: aboutPageRule,
    name: "about-page",
    label: "About page",
    path: "/pages/about-us",
    linkText: "About us",
    missing: { message: "No About page found", value: "Create /about or /about-us page" },
    passMessage: "About page exists with substantial content",
  },
  {
    rule: contactPageRule,
    name: "contact-page",
    label: "Contact page",
    path: "/pages/contact",
    linkText: "Contact",
    missing: { message: "No Contact page found", value: "Create /contact page" },
    passMessage: "Contact page exists",
  },
] as const;

for (const c of cases) {
  const target = `${ORIGIN}${c.path}`;
  const home = (footer: string) => ({
    url: `${ORIGIN}/`,
    html: html("Storefront", `<footer>${footer}</footer>`),
  });
  const link = `<a href="${c.path}">${c.linkText}</a>`;

  describe(`${c.rule.meta.id}: linked but not crawled (pub#740)`, () => {
    test("missing: no page and no link still warns with the create advice", () => {
      const checks = run(c.rule, siteCtx([home("")]));
      expect(checks).toEqual([{ name: c.name, status: "warn", ...c.missing }]);
    });

    test("crawled: the linked page the crawl fetched passes", () => {
      const checks = run(
        c.rule,
        siteCtx([home(link), { url: target, html: html(c.label, FILLER) }]),
      );
      expect(checks.find((k) => k.name === c.name)).toMatchObject({
        status: "pass",
        message: c.passMessage,
      });
    });

    test("excluded: a linked page the crawl did not fetch is info, not create advice", () => {
      const checks = run(c.rule, siteCtx([home(link)]));
      expect(checks).toEqual([
        {
          name: c.name,
          status: "info",
          message: `${c.label} linked but not crawled`,
          value: target,
          details: { linkedFrom: `${ORIGIN}/` },
        },
      ]);
    });

    test("a probed 404 on the uncrawled link warns that it is broken", () => {
      const checks = run(
        c.rule,
        siteCtx([home(link)], [{ url: target, status: 404, error: null }]),
      );
      expect(checks).toEqual([
        {
          name: c.name,
          status: "warn",
          message: `${c.label} link returns 404`,
          value: target,
          details: { linkedFrom: `${ORIGIN}/`, probedStatus: 404 },
        },
      ]);
    });

    test("a probed 403 is not read as broken", () => {
      const checks = run(
        c.rule,
        siteCtx([home(link)], [{ url: target, status: 403, error: null }]),
      );
      expect(checks[0]?.status).toBe("info");
    });

    test("a link to another site's page at a matching slug is not this site's page", () => {
      // e.g. a footer link to a social profile's /about or a partner's /contact.
      const checks = run(
        c.rule,
        siteCtx([home(`<a href="https://social.example${c.path}">${c.linkText}</a>`)]),
      );
      expect(checks[0]).toMatchObject({ status: "warn", ...c.missing });
    });

    test("a target the crawl reached through a redirect counts as crawled", () => {
      const checks = run(
        c.rule,
        siteCtx([home(link), { url: `${ORIGIN}/old`, finalUrl: target, html: html("Moved", "") }]),
      );
      // The crawl fetched it, so the rule's own page test judges it; it is never
      // reported as linked but not crawled.
      expect(checks[0]?.message).not.toContain("not crawled");
    });

    test("anchor text alone is not enough: the href must match a known slug", () => {
      const checks = run(c.rule, siteCtx([home(`<a href="/pages/team">${c.linkText}</a>`)]));
      expect(checks[0]).toMatchObject({ status: "warn", message: c.missing.message });
    });

    test("a crawled page at a matching slug is judged by the rule, not reported as uncrawled", () => {
      const checks = run(c.rule, siteCtx([home(link), { url: target, html: html(c.label, "") }]));
      expect(checks.find((k) => k.name === c.name)?.message).not.toContain("not crawled");
    });
  });
}

describe("eeat/contact-page: an uncrawled contact page has no methods check", () => {
  test("contact-methods is not emitted for a page that was never read", () => {
    const checks = run(
      contactPageRule,
      siteCtx([
        {
          url: `${ORIGIN}/`,
          html: html(
            "Storefront",
            '<a href="/contact">Contact</a><a href="mailto:a@shop.example">Mail</a><a href="tel:+15550100">Call</a>',
          ),
        },
      ]),
    );
    expect(checks.map((k) => k.name)).toEqual(["contact-page"]);
  });
});
