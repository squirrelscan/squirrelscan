// Privacy-policy page detection — shared acceptance for eeat + legal (#1098).
//
// A /privacy page titled "Privacy Policy", footer-linked and crawled, was warned
// by eeat/privacy-policy despite existing. Detection now accepts known privacy
// slugs (bare /privacy, /privacy-policy, /legal/privacy) AND any crawled page
// whose title/h1 reads "privacy policy", and both categories share the helper.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { privacyPolicyRule as eeatPrivacyRule } from "../src/eeat/privacy-policy";
import { privacyPolicyRule as legalPrivacyRule } from "../src/legal/privacy-policy";
import type { ParsedPage, Rule, RuleContext, SiteData } from "../src/types";

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

// A page carrying a footer link to /privacy — used to seed the crawl set.
function homeWithFooter(): { url: string; html: string } {
  return {
    url: "https://ex.com/",
    html: `<html><head><title>Home</title></head><body><footer><a href="/privacy">Privacy Policy</a></footer></body></html>`,
  };
}

function privacyPageAt(url: string, slugHint = "privacy"): { url: string; html: string } {
  return {
    url,
    html: `<html><head><title>Privacy Policy — Scram News</title></head><body><h1>Privacy Policy</h1><p>How we handle ${slugHint} data.</p><footer><a href="/privacy">Privacy Policy</a></footer></body></html>`,
  };
}

describe("eeat/privacy-policy — bare slug + title/h1 fallback (#1098)", () => {
  test("bare /privacy page (title+h1 'Privacy Policy'), footer-linked, is detected", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([homeWithFooter(), privacyPageAt("https://ex.com/privacy")]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
    // Footer anchor to /privacy is recognized as a privacy link.
    expect(check(checks, "privacy-linked")?.status).toBe("pass");
  });

  test("/legal/privacy slug is detected", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([homeWithFooter(), privacyPageAt("https://ex.com/legal/privacy")]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("link-percentage counts href-slug links only, not anchor text (metric not widened)", () => {
    // Page A links to /privacy by href (counts). Page B has only a text-only
    // "Privacy Preferences" link pointing at /cookie-settings (must NOT count) —
    // so coverage is 50% (info), not 100% (pass) as anchor-text matching gave.
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/privacy",
          html: `<html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1><footer><a href="/privacy">Privacy Policy</a></footer></body></html>`,
        },
        {
          url: "https://ex.com/blog",
          html: `<html><body><a href="/cookie-settings">Manage Privacy Preferences</a></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
    expect(check(checks, "privacy-linked")?.status).toBe("info");
  });

  test("title/h1 'Privacy Policy' credits a page even with an unrecognized slug", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([privacyPageAt("https://ex.com/site/legal-info-2024")]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("slug-only match: unrecognized title/h1 but bare /privacy slug still passes", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/privacy",
          html: `<html><head><title>Data & You</title></head><body><h1>Data & You</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("blog title merely containing the phrase mid-sentence is NOT credited", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/blog/how-we-updated-our-privacy-policy-this-year",
          html: `<html><head><title>How We Updated Our Privacy Policy This Year</title></head><body><h1>How We Updated Our Privacy Policy This Year</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });

  test("arbitrary continuation is NOT credited ('Privacy Policy Changes in 2026')", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/blog/privacy-policy-changes-2026",
          html: `<html><head><title>Privacy Policy Changes in 2026</title></head><body><h1>Privacy Policy Changes in 2026</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });

  test("parenthesized qualifier is credited ('Privacy Policy (Updated July 2026)')", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/legal-doc",
          html: `<html><head><title>Privacy Policy (Updated July 2026)</title></head><body><h1>Privacy Policy (Updated July 2026)</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("keyword+date qualifier is credited ('Privacy Policy — Last updated 2026-07-01')", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/legal-doc",
          html: `<html><head><title>Privacy Policy — Last updated 2026-07-01</title></head><body><h1>Privacy Policy — Last updated 2026-07-01</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("bare year qualifier is credited ('Privacy Policy 2026')", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/legal-doc",
          html: `<html><head><title>Privacy Policy 2026</title></head><body><h1>Privacy Policy 2026</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("year followed by arbitrary text is NOT credited ('Privacy Policy 2026 Complete Guide')", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/blog/privacy-policy-2026-guide",
          html: `<html><head><title>Privacy Policy 2026 Complete Guide To Tracking</title></head><body><h1>Privacy Policy 2026 Complete Guide To Tracking</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });

  test("exact 'Privacy Notice' heading is credited", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/legal-doc",
          html: `<html><head><title>Privacy Notice</title></head><body><h1>Privacy Notice</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("underscore slug /privacy_policy is detected (anchor text unrelated)", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/privacy_policy",
          html: `<html><head><title>Legal</title></head><body><h1>Legal</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("reversed title order 'Site | Privacy Policy' is credited", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/legal-2024",
          html: `<html><head><title>Scram News | Privacy Policy</title></head><body><h1>Privacy Policy</h1></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("site with no privacy page still warns", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        { url: "https://ex.com/", html: "<html><body><p>Home</p></body></html>" },
        { url: "https://ex.com/blog", html: "<html><body><p>A post</p></body></html>" },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });

  test("a blog post merely mentioning privacy is NOT credited", () => {
    const checks = run(
      eeatPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/blog/why-privacy-matters",
          html: `<html><head><title>Why privacy matters in 2026</title></head><body><h1>Why privacy matters</h1><p>Thoughts on privacy and cookies.</p></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });
});

describe("legal/privacy-policy — shares acceptance with eeat (#1098)", () => {
  test("bare /privacy page (title+h1) is credited", () => {
    const checks = run(
      legalPrivacyRule,
      siteCtx([homeWithFooter(), privacyPageAt("https://ex.com/privacy")]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("footer link to /privacy alone is credited, value is the link href", () => {
    const checks = run(legalPrivacyRule, siteCtx([homeWithFooter()]));
    const c = check(checks, "privacy-policy");
    expect(c?.status).toBe("pass");
    // Reports the matched privacy href, not the containing page.
    expect(c?.value).toBe("https://ex.com/privacy");
  });

  test("real /privacy href wins over an earlier weak text-only link (value)", () => {
    // A cookie-consent "Manage Privacy Preferences" link appears BEFORE the real
    // footer privacy-policy link. The href-slug match must win over the earlier
    // text-only match, so value is /privacy, not /cookie-settings.
    const checks = run(
      legalPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/",
          html: `<html><body>
            <a href="/cookie-settings">Manage Privacy Preferences</a>
            <footer><a href="/privacy">Privacy Policy</a></footer>
          </body></html>`,
        },
      ]),
    );
    const c = check(checks, "privacy-policy");
    expect(c?.status).toBe("pass");
    expect(c?.value).toBe("https://ex.com/privacy");
  });

  test("footer link to /privacy_policy with unrelated anchor text is credited", () => {
    const checks = run(
      legalPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/",
          html: `<html><body><footer><a href="/privacy_policy">Legal</a></footer></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("accented localized slug link is credited (/politique-de-confidentialité)", () => {
    const checks = run(
      legalPrivacyRule,
      siteCtx([
        {
          url: "https://ex.com/",
          html: `<html><body><footer><a href="/politique-de-confidentialité">Politique de confidentialité</a></footer></body></html>`,
        },
      ]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("pass");
  });

  test("no privacy page/link warns (no GDPR regime)", () => {
    const checks = run(
      legalPrivacyRule,
      siteCtx([{ url: "https://ex.com/", html: "<html><body><p>Home</p></body></html>" }]),
    );
    expect(check(checks, "privacy-policy")?.status).toBe("warn");
  });
});
