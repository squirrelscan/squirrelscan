// legal/cookie-consent — structural detection, not raw-text (#1141).
//
// The rule used to match indicator substrings ("gdpr", "cookie-policy", …)
// against the whole lowercased page HTML, so a blog post merely mentioning
// cookies/GDPR passed as "consent mechanism detected". Detection now requires
// structural signals: a CMP loader script/stylesheet, a known CMP container, or
// a cookie/consent-keyed widget carrying an accept/reject control.

import { describe, expect, test } from "bun:test";

import type { CheckResult, SiteMetadata } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";

import { cookieConsentRule } from "../src/legal/cookie-consent";
import type { ParsedPage, RuleContext } from "../src/types";

function pageCtx(html: string, siteMetadata?: SiteMetadata): RuleContext {
  const parsed = parsePage(html, "https://example.com/");
  return {
    page: {
      url: "https://example.com/",
      html,
      statusCode: 200,
      loadTime: 0,
      headers: {},
    },
    parsed: parsed as ParsedPage,
    siteMetadata,
    options: {},
  };
}

function status(html: string, meta?: SiteMetadata): CheckResult["status"] | undefined {
  const checks = cookieConsentRule.run(pageCtx(html, meta)).checks;
  return checks.find((c) => c.name === "cookie-consent")?.status;
}

describe("legal/cookie-consent — no false positive on prose (#1141)", () => {
  test("blog post ABOUT cookies/GDPR does NOT pass as consent-detected", () => {
    const html = `<html><head><title>What the GDPR means for cookies</title></head>
      <body><article>
        <h1>Understanding GDPR and cookie policy</h1>
        <p>Under the GDPR, sites that set cookies must obtain consent. This post
        explains cookie-policy basics, the ePrivacy directive, and how a cookie
        banner should let users accept or reject non-essential cookies.</p>
        <a href="/cookie-policy">Read our cookie policy</a>
      </article></body></html>`;
    // No CMP script, no CMP container, no interactive widget → not detected.
    expect(status(html)).toBe("info");
  });

  test("prose mentioning gdpr with a GDPR audience warns (was falsely passing)", () => {
    const html = `<html><body><p>We discuss gdpr and cookie-policy topics here.</p></body></html>`;
    const meta = { audienceScope: "global" } as unknown as SiteMetadata;
    expect(status(html, meta)).toBe("warn");
  });
});

describe("legal/cookie-consent — real CMPs still detected (#1141)", () => {
  test("OneTrust loader script (cdn.cookielaw.org)", () => {
    const html = `<html><head>
      <script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js" data-domain-script="abc-123"></script>
      </head><body><p>hello</p></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("Cookiebot loader script", () => {
    const html = `<html><head>
      <script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="00000000"></script>
      </head><body><p>hello</p></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("Usercentrics loader script", () => {
    const html = `<html><head>
      <script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script>
      </head><body><p>hello</p></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("Shopify native privacy banner loader (shopifycloud/privacy-banner)", () => {
    const html = `<html><head>
      <script src="https://cdn.shopify.com/shopifycloud/privacy-banner/storefront-banner.js"></script>
      </head><body><p>store</p></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("CookieHub loader script (cookiehub.net)", () => {
    const html = `<html><head>
      <script src="https://cookiehub.net/c2/00000000.js"></script>
      </head><body><p>hello</p></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("capitalized class casing is discovered (class='CookieConsent')", () => {
    const html = `<html><body>
      <div class="CookieConsent"><p>We use cookies.</p><button>Accept</button></div>
      </body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("known CMP container in the DOM (OneTrust banner)", () => {
    const html = `<html><body>
      <div id="onetrust-banner-sdk"><p>We use cookies.</p></div>
      </body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("self-hosted banner: cookie-keyed div with an Accept control", () => {
    const html = `<html><body>
      <div class="cookie-banner" role="dialog">
        <p>We use cookies to improve your experience.</p>
        <button>Accept all</button>
        <button>Reject</button>
      </div></body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("localized (German) cookie banner via widget-token class", () => {
    const html = `<html><body>
      <div class="cookie-banner"><p>Wir verwenden Cookies.</p>
      <button>Akzeptieren</button><button>Ablehnen</button></div>
      </body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("localized button text on a cookie-keyed (non-widget-token) region", () => {
    const html = `<html><body>
      <div id="cookies"><p>Cookies</p><button>Tout accepter</button></div>
      </body></html>`;
    expect(status(html)).toBe("pass");
  });

  test("consent dialog about cookies with accept button (role=dialog, no cookie class)", () => {
    const html = `<html><body>
      <div role="dialog" aria-label="Privacy">
        <p>This site uses cookies for analytics.</p>
        <button>I agree</button>
      </div></body></html>`;
    expect(status(html)).toBe("pass");
  });
});

describe("legal/cookie-consent — negative controls", () => {
  test("generic newsletter modal (no cookie context) does not pass", () => {
    const html = `<html><body>
      <div role="dialog"><p>Subscribe to our newsletter</p><button>Subscribe</button></div>
      </body></html>`;
    expect(status(html)).toBe("info");
  });

  test("cookie-recipe blog with no consent control does not pass", () => {
    const html = `<html><body>
      <article class="cookie-recipe"><h1>Best chocolate chip cookies</h1>
      <p>Mix, bake, enjoy.</p></article></body></html>`;
    expect(status(html)).toBe("info");
  });

  test("bare consent-keyed widget (terms acceptance, no cookie context) does not pass", () => {
    const html = `<html><body>
      <div class="consent-section"><p>I have read the terms.</p>
      <button>Accept order</button></div></body></html>`;
    expect(status(html)).toBe("info");
  });

  test("rel=canonical link to a CMP vendor site does NOT pass", () => {
    const html = `<html><head>
      <link rel="canonical" href="https://www.cookiebot.com/en/">
      </head><body><p>A blog post about Cookiebot.</p></body></html>`;
    expect(status(html)).toBe("info");
  });
});
