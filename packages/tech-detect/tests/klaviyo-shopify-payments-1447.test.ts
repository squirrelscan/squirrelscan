// #1447: Klaviyo and Shopify Payments on a logged-out Shopify storefront, from the static HTML a local
// HTTP-only audit sees. Synthetic fixtures; a page that only links to or names a vendor is not detected.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const SHOPIFY_HEADERS = { server: "cloudflare", "powered-by": "Shopify" };
const BODIES = [{ url: "https://cdn.shopify.com/s/files/theme.js", content: "var a=1;" }];

const page = (head: string, body = "<p>Shop</p>") =>
  `<!doctype html><html><head><title>Shop</title>${head}</head><body>${body}</body></html>`;
const found = (html: string, scripts?: Array<{ url: string; content?: string }>): string[] =>
  detectTechnologies({ url: "https://shop.example.com/", headers: SHOPIFY_HEADERS, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
// Both script inputs a local audit can give: with the page's script bodies attached, and without.
const both = (html: string): string[][] => [found(html), found(html, BODIES)];

describe("Klaviyo", () => {
  test("the theme app block marker, in a comment or an attribute", () => {
    const block = "shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/00000000-0000-0000-0000-000000000000";
    for (const html of [page(`<!-- BEGIN app block: ${block} -->`), page(`<div data-block="${block}"></div>`)]) {
      for (const ids of both(html)) expect(ids).toContain("klaviyo");
    }
  });

  test("the inline onsite loader", () => {
    const loader = page("<script>window._klOnsite=window._klOnsite||[];</script>");
    const proxy = page("<script>window.klaviyo=window.klaviyo||new Proxy({}, {get(){return function(){}}});</script>");
    const proxy2 = page("<script>window.klaviyo = new Proxy({}, {});</script>");
    for (const html of [loader, proxy, proxy2]) for (const ids of both(html)) expect(ids).toContain("klaviyo");
  });

  test("the script and the legacy queue still match", () => {
    expect(found(page('<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=ABC123"></script>'))).toContain("klaviyo");
    expect(found(page("<script>var _learnq=_learnq||[];_learnq.push(['account','ABC123']);</script>"))).toContain("klaviyo");
  });

  test("a mention in prose, a link or a similarly named app is not Klaviyo", () => {
    const html = page(
      "",
      '<p>We send email with Klaviyo and window._klOnsite is documented elsewhere.</p><a href="https://www.klaviyo.com/">Klaviyo</a>' +
        '<p>shopify://apps/other-app/blocks/x</p><script>window.klaviyoLike = 1; window._klOnsiteX = 2;</script>',
    );
    for (const ids of both(html)) expect(ids).not.toContain("klaviyo");
  });
});

describe("Shopify Payments", () => {
  test("shopifyPaymentsEnabled true in the inline shop config", () => {
    const html = page('<script>var Shopify=Shopify||{};window.ShopifyAnalytics={meta:{},"shopifyPaymentsEnabled":true,"currency":"EUR"};</script>');
    for (const ids of both(html)) expect(ids).toContain("shopify-payments");
  });

  test("it is named as a shop-config flag, not a loaded SDK, at medium confidence", () => {
    const html = page('<script>var c={"shopifyPaymentsEnabled": true};</script>');
    const hit = detectTechnologies({ url: "https://shop.example.com/", headers: SHOPIFY_HEADERS, html }).find((t) => t.id === "shopify-payments");
    expect(hit?.name).toBe("Shopify Payments (enabled in shop config)");
    expect(hit?.confidence).toBe("medium");
  });

  test("false, a mention in prose and a similar key are not detected", () => {
    const html = page(
      '<script>var c={"shopifyPaymentsEnabled":false,"shopifyPaymentsEnabledX":true};</script>',
      "<p>Set shopifyPaymentsEnabled to true in your config.</p>",
    );
    for (const ids of both(html)) expect(ids).not.toContain("shopify-payments");
  });
});
