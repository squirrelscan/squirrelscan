// Stack fingerprints for logged-out audits (#1263): consent tools, tag managers, shop systems,
// CMS and CDNs, each detected from a minimal fixture and not from prose, code samples or a plain page.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src/detect";
import { STACK_FINGERPRINTS } from "../src/fingerprints/stack";
import type { TechDetectInput } from "../src/types";

const input = (partial: Partial<TechDetectInput>): TechDetectInput => ({
  url: "https://example.com/",
  headers: {},
  html: "",
  ...partial,
});
const ids = (i: TechDetectInput) => detectTechnologies(i).map((t) => t.id);
const STACK_IDS = STACK_FINGERPRINTS.map((f) => f.id);
const page = (head: string, body = "") =>
  `<!doctype html><html><head><title>Fixture</title>${head}</head><body>${body}</body></html>`;

const PLAIN = page(`<meta name="generator" content="WordPress 6.6">`, "<h1>Hello</h1>");
const BLOG = page(
  "",
  `<p>We compared Borlabs Cookie, Complianz, Real Cookie Banner, Cookie Notice, consentmanager, Klaro, Axeptio, CookieFirst,
Cookie Information, Cookie-Script, Cloudflare Zaraz, Matomo Tag Manager, Piwik PRO, Commanders Act, Lightspeed, Contao,
SilverStripe, Plone, Grav, Odoo, Liferay, Pimcore, Azure Front Door and Google Cloud CDN. Hosts: cdn.consentmanager.net,
static.axept.io, consent.cookiefirst.com, cdn.cookie-script.com, cdn.tagcommander.com, cdn.webshopapp.com, /cdn-cgi/zaraz/.</p>
<pre>&lt;script src="https://consent.cookiefirst.com/banner.js"&gt;&lt;/script&gt;
&lt;script&gt;window.klaroConfig = {}; window.axeptioSettings = {}; var borlabsCookieConfig = {};&lt;/script&gt;
&lt;meta name="generator" content="Contao Open Source CMS"&gt;</pre>`,
);

describe("stack fingerprints (#1263)", () => {
  test("every one has a category, an icon slug and a unique id", () => {
    expect(new Set(STACK_IDS).size).toBe(STACK_IDS.length);
    for (const fp of STACK_FINGERPRINTS) {
      expect(["security", "tag-manager", "cms", "cdn"]).toContain(fp.category);
      expect(fp.icon).toBeTruthy();
    }
  });

  test("a plain WordPress page and a post that only names them match none", () => {
    expect(ids(input({ html: PLAIN })).filter((id) => STACK_IDS.includes(id))).toEqual([]);
    expect(ids(input({ html: BLOG })).filter((id) => STACK_IDS.includes(id))).toEqual([]);
  });

  describe("detected from the product's own markup, host, path or header", () => {
    const plugin = (slug: string) =>
      page(
        `<link rel="stylesheet" href="https://example.com/wp-content/plugins/${slug}/assets/x.css">`,
      );
    const script = (src: string) => page(`<script async src="${src}"></script>`);
    test.each([
      ["borlabs-cookie", plugin("borlabs-cookie")],
      [
        "borlabs-cookie",
        page(`<script>window.borlabsCookieConfig = {"cookieName":"borlabs-cookie"};</script>`),
      ],
      [
        "borlabs-cookie",
        page("", `<script type="text/plain" data-borlabs-cookie-script-blocker-id="x"></script>`),
      ],
      ["complianz", plugin("complianz-gdpr")],
      [
        "complianz",
        page(
          "",
          `<div id="cmplz-cookiebanner-container"><div class="cmplz-cookiebanner cmplz-show">x</div></div>`,
        ),
      ],
      ["real-cookie-banner", plugin("real-cookie-banner-pro")],
      ["cookie-notice", plugin("cookie-notice")],
      ["consentmanager", script("https://cdn.consentmanager.net/delivery/autoblocking/abc123.js")],
      ["consentmanager", script("https://a1b2.delivery.consentmanager.net/delivery/cmp.php")],
      ["klaro", page(`<script>var klaroConfig = {acceptAll: true};</script>`)],
      ["klaro", script("/static/klaro-no-css.js")],
      ["axeptio", script("https://static.axept.io/sdk.js")],
      ["axeptio", page(`<script>window.axeptioSettings = {clientId: "x"};</script>`)],
      ["cookiefirst", script("https://consent.cookiefirst.com/sites/example.com-abc/consent.js")],
      ["cookie-information", script("https://policy.app.cookieinformation.com/uc.js")],
      ["cookie-script", script("https://cdn.cookie-script.com/s/abc123.js")],
      ["cloudflare-zaraz", script("/cdn-cgi/zaraz/i.js")],
      ["cloudflare-zaraz", page(`<script>window.zarazData = {};</script>`)],
      [
        "matomo-tag-manager",
        script("https://cdn.matomo.cloud/example.matomo.cloud/container_AbCd1234.js"),
      ],
      ["matomo-tag-manager", page(`<script>var _mtm = window._mtm = window._mtm || [];</script>`)],
      [
        "piwik-pro-tag-manager",
        script("https://example.containers.piwik.pro/0a1b2c3d-1111-2222-3333-444455556666.js"),
      ],
      ["commanders-act", script("https://cdn.tagcommander.com/1234/tc_example_1.js")],
      [
        "lightspeed-ecom",
        page(
          `<link rel="stylesheet" href="https://cdn.webshopapp.com/shops/1234/themes/5678/assets/style.css">`,
        ),
      ],
      [
        "lightspeed-ecom",
        page("", `<img src="https://example.shoplightspeed.com/assets/logo.png" alt="">`),
      ],
    ])("%s", (id, html) => {
      expect(ids(input({ html }))).toContain(id);
    });

    test.each([
      ["contao", "Contao Open Source CMS"],
      ["silverstripe", "SilverStripe - http://silverstripe.org"],
      ["plone", "Plone - http://plone.org"],
      ["grav", "GravCMS"],
      ["odoo", "Odoo"],
    ])("%s from the generator meta", (id, generator) => {
      expect(
        ids(input({ html: page(`<meta name="generator" content="${generator}">`) })),
      ).toContain(id);
      // Anchored: another product that merely contains the word does not match.
      expect(
        ids(input({ html: page(`<meta name="generator" content="Not ${generator}-based">`) })),
      ).not.toContain(id);
    });

    test.each([
      ["liferay", { "liferay-portal": "Liferay Community Edition Portal 7.4" }],
      ["pimcore", { "x-powered-by": "pimcore" }],
      ["azure-front-door", { "x-azure-ref": "20241030T000000Z-abc" }],
    ])("%s from a response header", (id, headers) => {
      const found = detectTechnologies(input({ headers, html: PLAIN })).find((t) => t.id === id);
      expect(found?.detectedBy).toBe(`header:${Object.keys(headers)[0]}`);
    });

    test("a Google Front End response (Cloud Run, a load balancer) is not reported as a CDN", () => {
      const html = page("", "<p>Hello</p>");
      expect(
        ids(input({ headers: { via: "1.1 google", server: "Google Frontend" }, html })),
      ).not.toContain("google-cloud-cdn");
    });

    test("look-alikes do not match: hosts, header values and links to the vendor", () => {
      expect(
        ids(input({ html: script("https://cdn.consentmanager.net.evil.example/x.js") })),
      ).not.toContain("consentmanager");
      expect(
        ids(input({ html: script("https://example.com/matomo/container_AbCd1234.js") })),
      ).not.toContain("matomo-tag-manager");
      expect(
        ids(input({ html: script("https://example.com/0a1b2c3d-1111-2222-3333-444455556666.js") })),
      ).not.toContain("piwik-pro-tag-manager");
      expect(ids(input({ headers: { "x-powered-by": "NotPimcore" }, html: PLAIN }))).not.toContain(
        "pimcore",
      );
      expect(
        ids(
          input({ html: page("", `<a href="https://consent.cookiefirst.com/">CookieFirst</a>`) }),
        ),
      ).not.toContain("cookiefirst");
    });
  });
});
