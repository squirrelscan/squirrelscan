// #1600: fingerprints for six third-party vendors, the Bing UET host and one Cloudflare beacon technology.
// Synthetic fixtures; each vendor has a page that loads it and pages that only name or link to it.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const page = (head: string, body = "<p>Hello</p>") => `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const ids = (html: string): string[] => detectTechnologies({ url: "https://www.example.com/", headers: {}, html }).map((t) => t.id);
const withScripts = (html: string, urls: string[]): string[] =>
  detectTechnologies({ url: "https://www.example.com/", headers: {}, html, scripts: urls.map((url) => ({ url })) }).map((t) => t.id);

const VENDORS: Array<{ id: string; head: string; urls: string[] }> = [
  { id: "debugbear", head: '<script async src="https://cdn.debugbear.com/AbCdEf123.js"></script>', urls: ["https://cdn.debugbear.com/AbCdEf123.js"] },
  { id: "partytown", head: '<script src="/~partytown/partytown.js"></script>', urls: ["/~partytown/partytown.js"] },
  { id: "partytown", head: '<script type="text/partytown">console.log(1)</script>', urls: [] },
  { id: "appsflyer", head: '<script src="https://websdk.appsflyer.com?afParameters=x"></script>', urls: ["https://websdk.appsflyer.com/"] },
  { id: "walletconnect", head: '<script src="https://unpkg.com/@walletconnect/web3-provider@1.8.0/dist/umd/index.min.js"></script>', urls: [] },
  { id: "walletconnect", head: '<script src="https://cdn.jsdelivr.net/npm/@reown/appkit@1.0.0/dist/index.js"></script>', urls: [] },
  { id: "magic-link", head: '<script src="https://auth.magic.link/sdk/magic.js"></script>', urls: ["https://auth.magic.link/sdk/magic.js"] },
  { id: "magic-link", head: '<script src="https://cdn.jsdelivr.net/npm/magic-sdk/dist/magic.js"></script>', urls: [] },
  { id: "vercel-web-analytics", head: '<script defer src="/_vercel/insights/script.js"></script>', urls: ["/_vercel/insights/script.js"] },
  { id: "vercel-web-analytics", head: '<script defer src="https://va.vercel-scripts.com/v1/script.js"></script>', urls: [] },
  { id: "vercel-speed-insights", head: '<script defer src="/_vercel/speed-insights/script.js"></script>', urls: ["/_vercel/speed-insights/script.js"] },
];

describe("new vendor fingerprints (#1600)", () => {
  test.each(VENDORS.map((v, i) => [`${v.id} #${i}`, v] as const))("%s is detected", (_n, v) => {
    expect(ids(page(v.head))).toContain(v.id);
    if (v.urls.length) expect(withScripts(page(""), v.urls)).toContain(v.id);
  });

  test("a page that only links to or names a vendor detects none of them", () => {
    const html = page(
      "<script>console.log('plain')</script>",
      '<a href="https://cdn.debugbear.com/AbCdEf123.js">a</a><a href="https://auth.magic.link/">m</a><a href="https://reown.com">r</a>' +
        '<a href="https://www.appsflyer.com">af</a><p>Partytown moves scripts off the main thread. Magic is great. WalletConnect, Vercel Analytics.</p>' +
        '<pre>&lt;script src="/_vercel/insights/script.js"&gt;</pre>',
    );
    const found = ids(html);
    for (const id of ["debugbear", "partytown", "appsflyer", "walletconnect", "magic-link", "vercel-web-analytics", "vercel-speed-insights"]) {
      expect(found, id).not.toContain(id);
    }
  });

  test("a different vendor script does not match: lookalike hosts and paths", () => {
    const found = ids(
      page(
        '<script src="https://example.com/magic-spells.js"></script><script src="https://cdn.example.com/debugbear-clone.js"></script>' +
          '<script src="/insights/script.js"></script><script src="https://cdn.example.com/partytown-notes.js"></script>',
      ),
    );
    for (const id of ["debugbear", "partytown", "magic-link", "vercel-web-analytics", "vercel-speed-insights"]) expect(found, id).not.toContain(id);
  });
});

describe("Bing UET host (#1600)", () => {
  test("bat.bing.net and bat.bing.com both detect Microsoft Advertising UET", () => {
    for (const host of ["bat.bing.net", "bat.bing.com"]) {
      expect(ids(page(`<script async src="https://${host}/bat.js"></script>`)), host).toContain("microsoft-uet");
      expect(withScripts(page(""), [`https://${host}/bat.js`]), host).toContain("microsoft-uet");
    }
  });
  test("a lookalike host does not", () => {
    expect(ids(page('<script src="https://bat.bing.example.net/bat.js"></script>'))).not.toContain("microsoft-uet");
  });
});

describe("Cloudflare beacon (#1600)", () => {
  const beacons = [
    page('<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"token":"x"}\'></script>'),
    page('<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>'),
    page('<script defer data-cf-beacon=\'{"token":"x"}\' src="/local.js"></script>'),
  ];
  test("one Cloudflare analytics technology, not two", () => {
    for (const html of beacons) {
      const found = ids(html).filter((id) => id.startsWith("cloudflare-") && id !== "cloudflare-cdn");
      expect(found, html).toEqual(["cloudflare-web-analytics"]);
    }
  });
  test("whitespace around the attribute equals is tolerated, as before the merge", () => {
    for (const attr of ["data-cf-beacon = '{\"token\":\"x\"}'", "data-cf-beacon\t=\n'{\"token\":\"x\"}'"]) {
      const found = ids(page(`<script src="/local.js" ${attr}></script>`)).filter(
        (id) => id.startsWith("cloudflare-") && id !== "cloudflare-cdn",
      );
      expect(found, attr).toEqual(["cloudflare-web-analytics"]);
    }
  });
  test("the rum endpoint alone is still detected, once", () => {
    const found = withScripts(page(""), ["https://cloudflareinsights.com/cdn-cgi/rum"]).filter((id) => id.startsWith("cloudflare-"));
    expect(found).toEqual(["cloudflare-web-analytics"]);
  });
});

describe("filename patterns end at a URL boundary (#1600)", () => {
  const FILES: Array<{ id: string; url: (ext: string) => string }> = [
    { id: "partytown", url: (e) => `/~partytown/partytown${e}` },
    { id: "partytown", url: (e) => `/~partytown/debug/partytown-sw${e}` },
    { id: "vercel-web-analytics", url: (e) => `/_vercel/insights/script${e}` },
    { id: "vercel-web-analytics", url: (e) => `https://va.vercel-scripts.com/v1/script.debug${e}` },
    { id: "vercel-speed-insights", url: (e) => `/_vercel/speed-insights/script${e}` },
    { id: "vercel-speed-insights", url: (e) => `https://va.vercel-scripts.com/v1/speed-insights/script${e}` },
    { id: "microsoft-uet", url: (e) => `https://bat.bing.com/bat${e}` },
    { id: "microsoft-uet", url: (e) => `https://bat.bing.net/bat${e}` },
    { id: "cloudflare-web-analytics", url: (e) => `https://static.cloudflareinsights.com/beacon.min${e}` },
    { id: "cloudflare-web-analytics", url: (e) => `https://static.cloudflareinsights.com/beacon${e}` },
  ];
  const tag = (src: string) => page(`<script src="${src}"></script>`);

  for (const f of FILES) {
    test(`${f.id} ${f.url(".js")}: .js, .js?v=1 and .js#x detect`, () => {
      for (const ext of [".js", ".js?v=1", ".js#x"]) {
        expect(ids(tag(f.url(ext))), f.url(ext)).toContain(f.id);
        expect(withScripts(page(""), [f.url(ext)]), f.url(ext)).toContain(f.id);
      }
    });
    test(`${f.id} ${f.url(".js")}: .json, .jsx, .js.map and .jsonp do not`, () => {
      for (const ext of [".json", ".jsx", ".js.map", ".jsonp"]) {
        expect(ids(tag(f.url(ext))), f.url(ext)).not.toContain(f.id);
        expect(withScripts(page(""), [f.url(ext)]), f.url(ext)).not.toContain(f.id);
      }
    });
  }
});
