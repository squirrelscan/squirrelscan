// security/sri — cross-origin scripts/styles without integrity are flagged.
// #748: false-positive caution — first-party-only pages (no cross-origin
// resources at all) must pass cleanly, and known SRI-incompatible SDKs
// (Stripe, reCAPTCHA, GA/GTM) must not be flagged.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { checkRuleOptions } from "../src/rule-options-check";
import { sriRule } from "../src/security/sri";
import type { RuleContext } from "../src/types";

function ctx(html: string, url = "https://example.com/", options: Record<string, unknown> = {}): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options,
  } as unknown as RuleContext;
}

function page(headHtml: string): string {
  return `<!DOCTYPE html><html><head><title>t</title>${headHtml}</head><body>content</body></html>`;
}

function sriCheck(checks: ReturnType<typeof sriRule.run>["checks"]) {
  return checks.find((c) => c.name === "sri");
}

describe("security/sri", () => {
  test("no scripts/styles at all: not applicable, passes cleanly", () => {
    const html = page("");
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("first-party-only page (relative + same-origin URLs): passes cleanly, no cross-origin flags", () => {
    const html = page(`
      <script src="/assets/app.js"></script>
      <script src="app2.js"></script>
      <link rel="stylesheet" href="/assets/style.css">
      <link rel="stylesheet" href="https://example.com/other.css">
    `);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("protocol-relative same-origin URL is not flagged as cross-origin", () => {
    const html = page(`<script src="//example.com/app.js"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("cross-origin script without integrity: flagged", () => {
    const html = page(`<script src="https://cdn.example.net/lib.js"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("warn");
    expect(sriCheck(checks)?.items?.[0]?.id).toBe("https://cdn.example.net/lib.js");
  });

  test("protocol-relative cross-origin script without integrity: flagged (resolved via page URL base)", () => {
    const html = page(`<script src="//cdn.example.net/lib.js"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("warn");
  });

  test("cross-origin stylesheet without integrity: flagged", () => {
    const html = page(`<link rel="stylesheet" href="https://fonts.example.net/font.css">`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("warn");
  });

  test("cross-origin script WITH integrity: passes", () => {
    const html = page(
      `<script src="https://cdn.example.net/lib.js" integrity="sha384-abc123" crossorigin="anonymous"></script>`,
    );
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("pass");
  });

  test("mix of protected and unprotected: flags only the unprotected one", () => {
    const html = page(`
      <script src="https://cdn.example.net/a.js" integrity="sha384-abc"></script>
      <script src="https://cdn.example.net/b.js"></script>
    `);
    const { checks } = sriRule.run(ctx(html));
    const check = sriCheck(checks);
    expect(check?.status).toBe("warn");
    expect(check?.items).toHaveLength(1);
    expect(check?.items?.[0]?.id).toBe("https://cdn.example.net/b.js");
  });

  test("known SRI-incompatible SDKs (Stripe, GTM, reCAPTCHA) are exempt, not flagged", () => {
    const html = page(`
      <script src="https://js.stripe.com/v3/"></script>
      <script src="https://www.googletagmanager.com/gtm.js?id=GTM-XXX"></script>
      <script src="https://www.google.com/recaptcha/api.js"></script>
    `);
    const { checks } = sriRule.run(ctx(html));
    // All 3 are cross-origin but exempt — no flagged resources, so the rule
    // reads as "nothing to flag" rather than a pass on 0 checked resources.
    expect(sriCheck(checks)?.status).toBe("pass");
  });

  test("inline script (no src) is not evaluated", () => {
    const html = page(`<script>console.log("hi")</script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("data: URI script src is not treated as a cross-origin fetch", () => {
    const html = page(`<script src="data:text/javascript,console.log(1)"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("non-http(s) scheme with a host (e.g. ftp:) is not a browser subresource SRI applies to", () => {
    const html = page(`<script src="ftp://cdn.example.net/lib.js"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("info");
  });

  test("same hostname but different port is cross-origin (origin, not just hostname, comparison)", () => {
    const html = page(`<script src="https://example.com:8443/app.js"></script>`);
    const { checks } = sriRule.run(ctx(html));
    expect(sriCheck(checks)?.status).toBe("warn");
  });

  test('token-list rel values are matched, not just an exact rel="stylesheet"', () => {
    const html = page(`
      <link rel="preload stylesheet" href="https://fonts.example.net/a.css" as="style">
      <link rel="alternate stylesheet" href="https://fonts.example.net/b.css" title="dark">
    `);
    const { checks } = sriRule.run(ctx(html));
    const check = sriCheck(checks);
    expect(check?.status).toBe("warn");
    expect(check?.items).toHaveLength(2);
  });
});

describe("security/sri wording is count-independent (#231)", () => {
  test("one and several flagged resources share one message form", () => {
    const one = sriCheck(sriRule.run(ctx(page(`<script src="https://cdn.example.net/a.js"></script>`))).checks);
    const two = sriCheck(
      sriRule.run(
        ctx(page(`<script src="https://cdn.example.net/a.js"></script><link rel="stylesheet" href="https://cdn.example.net/b.css">`)),
      ).checks,
    );
    expect(one?.message).toBe("1 cross-origin resource(s) without Subresource Integrity");
    expect(two?.message).toBe("2 cross-origin resource(s) without Subresource Integrity");
  });
});


describe("security/sri platform scripts and exempt_hosts (pub#546)", () => {
  const flaggedIds = (html: string, options: Record<string, unknown> = {}) =>
    (sriCheck(sriRule.run(ctx(page(html), "https://www.store.example/", options)).checks)?.items ?? []).map((i) => i.id);

  test("Shopify's own /shopifycloud/ and /storefront/ scripts are not reported", () => {
    const html = `
      <script src="https://cdn.shopify.com/shopifycloud/shop-js/modules/v2/loader.init-shop-cart-sync.de.esm.js"></script>
      <script src="https://cdn.shopify.com/storefront/standard-actions.js"></script>
    `;
    const check = sriCheck(sriRule.run(ctx(page(html), "https://www.store.example/")).checks);
    expect(check?.status).toBe("pass");
  });

  test("a theme or app asset elsewhere on cdn.shopify.com is still reported", () => {
    const theme = "https://cdn.shopify.com/s/files/1/0000/0001/t/2/assets/theme.js?v=123456";
    const app = "https://cdn.shopify.com/extensions/0a1b2c3d/app/assets/widget-latest.js";
    expect(flaggedIds(`<script src="${theme}"></script><script src="${app}"></script>`)).toEqual([theme, app]);
  });

  test("a prefix only matches from the start of the path", () => {
    const url = "https://cdn.shopify.com/s/files/shopifycloud/x.js";
    expect(flaggedIds(`<script src="${url}"></script>`)).toEqual([url]);
  });

  test("a versioned third-party script without integrity is still reported", () => {
    const url = "https://cdn.jsdelivr.net/npm/x@1.2.3/x.js";
    expect(flaggedIds(`<script src="${url}"></script>`)).toEqual([url]);
  });

  test("a host listed in exempt_hosts is not reported; one not listed is", () => {
    const klaviyo = "https://static.klaviyo.com/onsite/js/abc/klaviyo.js";
    const plausible = "https://plausible.io/js/script.pageview-props.revenue.tagged-events.js";
    const html = `<script src="${klaviyo}"></script><link rel="stylesheet" href="https://Static.Klaviyo.com/a.css"><script src="${plausible}"></script>`;
    // Scripts are listed before stylesheets.
    expect(flaggedIds(html)).toEqual([klaviyo, plausible, "https://Static.Klaviyo.com/a.css"]);
    expect(flaggedIds(html, { exempt_hosts: ["STATIC.klaviyo.com"] })).toEqual([plausible]);
    // A terminal dot names the same host, on either side.
    expect(flaggedIds(html, { exempt_hosts: ["static.klaviyo.com.", "plausible.io"] })).toEqual([]);
    expect(flaggedIds(`<script src="https://js.stripe.com./v3/"></script>`)).toEqual([]);
  });

  test("exempt_hosts accepts bare hostnames only, and config validation names the bad entry", () => {
    expect(checkRuleOptions({ "security/sri": { exempt_hosts: ["static.klaviyo.com", "static.klaviyo.com."] } })).toEqual([]);
    for (const bad of ["https://static.klaviyo.com", "static.klaviyo.com/onsite", "static.klaviyo.com:443", "*.klaviyo.com", ""]) {
      const problems = checkRuleOptions({ "security/sri": { exempt_hosts: [bad] } });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ kind: "invalid-value", key: "exempt_hosts" });
      expect(problems[0]?.message).toContain('[rule_options."security/sri"] exempt_hosts.0: must be a hostname');
    }
    expect(checkRuleOptions({ "security/sri": { exempt_hosts: "static.klaviyo.com" } })[0]?.kind).toBe("invalid-value");
  });
});
