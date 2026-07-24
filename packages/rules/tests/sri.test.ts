// security/sri — cross-origin scripts/styles without integrity are flagged.
// #748: false-positive caution — first-party-only pages (no cross-origin
// resources at all) must pass cleanly, and known SRI-incompatible SDKs
// (Stripe, reCAPTCHA, GA/GTM) must not be flagged.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";

import { sriRule } from "../src/security/sri";
import type { RuleContext } from "../src/types";

function ctx(html: string, url = "https://example.com/"): RuleContext {
  return {
    page: { url, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, url),
    options: {},
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
