// #1448: Firebase Hosting is read from the page's own host and Firebase Hosting's own `Vary` entry, never from a
// `*.web.app` URL somewhere in the page HTML (a Shopify store whose third-party app loads a script from
// Firebase Hosting is not hosted there). Synthetic fixtures only.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const SHOPIFY_HEADERS = {
  server: "cloudflare",
  "powered-by": "Shopify",
  "server-timing": 'processing;dur=487;desc="gc:16", db;dur=79, edge;desc="SYD"',
  "x-dc": "gcp-australia-southeast2,gcp-us-west1,gcp-us-west1",
  vary: "Accept, accept-encoding",
};

const ids = (url: string, headers: Record<string, string>, html: string): string[] =>
  detectTechnologies({ url, headers, html }).map((t) => t.id);

const page = (body: string) => `<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`;

describe("not Firebase Hosting", () => {
  test("a Shopify storefront with gcp x-dc headers", () => {
    expect(ids("https://shop.example.com/", SHOPIFY_HEADERS, page("<p>store</p>"))).not.toContain("firebase-hosting");
  });

  test("a storefront whose third-party app script is served from *.web.app or *.firebaseapp.com", () => {
    const html = page(
      '<script src="https://example-app.web.app/main.js?shop=x.myshopify.com"></script>' +
        '<script src="https://other-app.firebaseapp.com/sdk.js"></script>' +
        "<p>see https://docs.web.app/ and https://thing.firebaseapp.com</p>",
    );
    expect(ids("https://shop.example.com/", SHOPIFY_HEADERS, html)).not.toContain("firebase-hosting");
  });

  test("a host that only contains the suffix", () => {
    for (const url of ["https://evil-web.app/", "https://web.app.example.com/", "https://firebaseapp.com.example.net/"]) {
      expect(ids(url, {}, page(""))).not.toContain("firebase-hosting");
    }
  });
});

describe("Firebase Hosting", () => {
  test("a *.web.app or *.firebaseapp.com host", () => {
    for (const url of ["https://my-site.web.app/", "https://my-project.firebaseapp.com/page", "https://web.app/"]) {
      expect(ids(url, {}, page(""))).toContain("firebase-hosting");
    }
  });

  test("Firebase Hosting's own Vary entry, on any host", () => {
    expect(ids("https://www.example.com/", { vary: "Accept-Encoding, x-fh-requested-host" }, page(""))).toContain("firebase-hosting");
  });

  test("an unparseable page URL does not throw", () => {
    expect(() => ids("not a url", {}, page(""))).not.toThrow();
  });
});
