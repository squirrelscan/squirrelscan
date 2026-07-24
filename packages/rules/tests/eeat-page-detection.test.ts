// eeat page detection — about/contact/privacy URL matching.
//
// Regression coverage for issue #121: detection missed `.html` suffixes
// (`/about.html`) and non-English slugs (`/ueber-mich.html`, `/kontakt.html`,
// `/datenschutz.html`). Also covers the Schema.org @type fallback for
// about/contact pages when the URL slug isn't recognized.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { aboutPageRule } from "../src/eeat/about-page";
import { contactPageRule } from "../src/eeat/contact-page";
import { privacyPolicyRule } from "../src/eeat/privacy-policy";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

// ── Helpers ─────────────────────────────────────────────────────────

// >=200 words so the about-page rule reports "substantial content".
const FILLER = `<p>${Array.from({ length: 220 }, (_, i) => `word${i}`).join(" ")}</p>`;

function siteCtx(pagesHtml: { url: string; html: string }[]): RuleContext {
  const pages: SiteData["pages"] = pagesHtml.map((p) => ({
    url: p.url,
    statusCode: 200,
    parsed: parsePage(p.html, p.url),
  }));
  return {
    page: {
      url: pages[0]?.url ?? "https://example.com/",
      html: "",
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: pages[0]?.parsed ?? ({} as ParsedPage),
    site: { baseUrl: "https://example.com", pages, robotsTxt: null, sitemaps: null },
    options: {},
  };
}

function run(rule: Rule, ctx: RuleContext): CheckResult[] {
  return rule.run(ctx).checks;
}

function check(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function page(url: string, body: string): { url: string; html: string } {
  return { url, html: `<html><body>${body}</body></html>` };
}

// ── About page ──────────────────────────────────────────────────────

describe("eeat/about-page — URL detection", () => {
  test("matches /about (existing English, no regression)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/about", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("matches /about/ (trailing slash, no regression)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/about/", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("matches /about.html (.html suffix — #121)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/about.html", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("matches /about-us.htm (.htm suffix — #121)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/about-us.htm", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("matches German /ueber-mich.html (#121)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/ueber-mich.html", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("matches Spanish /acerca-de (#121)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/acerca-de", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });

  test("does NOT match unrelated /about/team subpage", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/about/team", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("warn");
  });

  test("does NOT match /abouting (no false partial match)", () => {
    const checks = run(aboutPageRule, siteCtx([page("https://ex.com/abouting", FILLER)]));
    expect(check(checks, "about-page")?.status).toBe("warn");
  });

  test("falls back to Schema.org AboutPage @type on unknown slug (#121)", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      { "@context": "https://schema.org", "@type": "AboutPage" },
    )}</script></head><body>${FILLER}</body></html>`;
    const checks = run(aboutPageRule, siteCtx([{ url: "https://ex.com/p/42", html }]));
    expect(check(checks, "about-page")?.status).toBe("pass");
  });
});

// ── Contact page ────────────────────────────────────────────────────

describe("eeat/contact-page — URL detection", () => {
  const methods = `<a href="mailto:a@ex.com">Email</a><a href="tel:+1">Call</a>`;

  test("matches /contact (existing English, no regression)", () => {
    const checks = run(contactPageRule, siteCtx([page("https://ex.com/contact", methods)]));
    expect(check(checks, "contact-page")?.status).toBe("pass");
  });

  test("matches /kontakt.html (German + .html — #121)", () => {
    const checks = run(contactPageRule, siteCtx([page("https://ex.com/kontakt.html", methods)]));
    expect(check(checks, "contact-page")?.status).toBe("pass");
  });

  test("matches Spanish /contacto.htm (#121)", () => {
    const checks = run(contactPageRule, siteCtx([page("https://ex.com/contacto.htm", methods)]));
    expect(check(checks, "contact-page")?.status).toBe("pass");
  });

  test("does NOT match unrelated path", () => {
    const checks = run(contactPageRule, siteCtx([page("https://ex.com/products", methods)]));
    expect(check(checks, "contact-page")?.status).toBe("warn");
  });

  test("falls back to Schema.org ContactPage @type on unknown slug (#121)", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      { "@context": "https://schema.org", "@type": "ContactPage" },
    )}</script></head><body>${methods}</body></html>`;
    const checks = run(contactPageRule, siteCtx([{ url: "https://ex.com/p/7", html }]));
    expect(check(checks, "contact-page")?.status).toBe("pass");
  });

  test("does NOT treat homepage @graph ContactPoint as the contact page", () => {
    // ContactPoint is org contact metadata that appears on the homepage /
    // every page; it must not be mistaken for a contact page. Using an @graph
    // surfaces ContactPoint as a top-level schema type — under the old
    // `hasType("ContactPoint")` fallback this homepage would wrongly pass.
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Ex" },
          { "@type": "ContactPoint", telephone: "+1", contactType: "sales" },
        ],
      },
    )}</script></head><body>${FILLER}</body></html>`;
    const ctx = siteCtx([{ url: "https://ex.com/", html }]);
    // Sanity: the parser does surface ContactPoint as a type on this page.
    expect(ctx.site?.pages[0]?.parsed.schemas.hasType("ContactPoint")).toBe(true);
    const checks = run(contactPageRule, ctx);
    expect(check(checks, "contact-page")?.status).toBe("warn");
  });
});

// ── Privacy policy ──────────────────────────────────────────────────

describe("eeat/privacy-policy — URL detection", () => {
  test("matches /privacy-policy (existing English, no regression)", () => {
    const checks = run(privacyPolicyRule, siteCtx([page("https://ex.com/privacy-policy", FILLER)]));
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("matches German /datenschutz.html (#121)", () => {
    const checks = run(privacyPolicyRule, siteCtx([page("https://ex.com/datenschutz.html", FILLER)]));
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("matches French /confidentialite.htm (#121)", () => {
    const checks = run(privacyPolicyRule, siteCtx([page("https://ex.com/confidentialite.htm", FILLER)]));
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("does NOT match unrelated path", () => {
    const checks = run(privacyPolicyRule, siteCtx([page("https://ex.com/blog", FILLER)]));
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });
});

// ── Combined German .html site (issue #121 repro) ───────────────────

describe("German .html site — issue #121 repro", () => {
  const site = siteCtx([
    page("https://ex.de/", FILLER),
    page("https://ex.de/ueber-mich.html", FILLER),
    page("https://ex.de/kontakt.html", `<a href="mailto:a@ex.de">Mail</a>`),
    page("https://ex.de/datenschutz.html", FILLER),
  ]);

  test("about, contact, and privacy all detected", () => {
    expect(check(run(aboutPageRule, site), "about-page")?.status).toBe("pass");
    expect(check(run(contactPageRule, site), "contact-page")?.status).toBe("pass");
    expect(check(run(privacyPolicyRule, site), "privacy-policy")?.status).toBe("pass");
  });
});
