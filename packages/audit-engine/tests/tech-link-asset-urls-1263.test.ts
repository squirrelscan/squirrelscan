// #1263: a script-url detector with a script list never reads the HTML, so a signal that
// lives in a stylesheet path was invisible to it. The shared builder now lists the page's
// stylesheet and preload hrefs beside its scripts, so the local scan and the cloud payload
// see them the same way.

import { describe, expect, test } from "bun:test";

import {
  buildTechInputs,
  detectReportTechnologiesMulti,
  extractLinkAssetHrefs,
} from "../src/technologies";

describe("extractLinkAssetHrefs", () => {
  test("stylesheets, preloads and module preloads, in order; nothing else", () => {
    const html = `<head>
<link rel="stylesheet" href="/a.css">
<link rel="icon" href="/favicon.ico">
<link href="/b.css" rel="Stylesheet" media="print">
<link rel="preload" as="font" href="/f.woff2">
<link rel="modulepreload" href="/m.js">
<link rel="alternate stylesheet" href="/alt.css">
<link rel="canonical" href="/page">
<a href="/not-a-link-tag.css">x</a>
<style>@import url("/imported.css");</style></head>`;
    expect(extractLinkAssetHrefs(html)).toEqual([
      "/a.css",
      "/b.css",
      "/f.woff2",
      "/m.js",
      "/alt.css",
    ]);
  });

  test("unquoted and single-quoted attributes, any attribute order, rel with several words", () => {
    const html = `<link rel=stylesheet href=/plain.css><link href='/single.css' rel='preload stylesheet'><link REL="StyleSheet" HREF="/upper.css"><link rel=icon href=/i.ico>`;
    expect(extractLinkAssetHrefs(html)).toEqual(["/plain.css", "/single.css", "/upper.css"]);
  });

  test("bounded: a hostile page of unclosed tags costs its prefix", () => {
    const hostile = `<link rel="stylesheet" href="/x.css"`.repeat(50_000);
    expect(extractLinkAssetHrefs(hostile)).toEqual([]);
  });
});

describe("the home page lists its stylesheet URLs beside its scripts", () => {
  const html = `<html><head>
<link rel="stylesheet" href="https://example.com/wp-content/plugins/woocommerce/assets/css/woocommerce.css">
<script src="/app.js"></script></head></html>`;

  test("buildTechInputs", () => {
    const [home] = buildTechInputs([{ url: "https://example.com/", headers: {}, html }], []);
    expect(home?.scripts?.map((s) => s.url)).toEqual([
      "/app.js",
      "https://example.com/wp-content/plugins/woocommerce/assets/css/woocommerce.css",
    ]);
  });

  test("a stylesheet-path signal is detected on a page that also has scripts", () => {
    const inputs = buildTechInputs([{ url: "https://example.com/", headers: {}, html }], []);
    const ids = detectReportTechnologiesMulti(inputs).items.map((t) => t.id);
    expect(ids).toContain("woocommerce");
  });

  test("an unquoted stylesheet link is detected too (WooCommerce)", () => {
    const unquoted = `<html><head><link rel=stylesheet href=/wp-content/plugins/woocommerce/assets/css/woocommerce.css><script src="/app.js"></script></head></html>`;
    const inputs = buildTechInputs(
      [{ url: "https://example.com/", headers: {}, html: unquoted }],
      [],
    );
    expect(detectReportTechnologiesMulti(inputs).items.map((t) => t.id)).toContain("woocommerce");
  });

  test("a page with 70 stylesheets cannot push its scripts out, and its link URLs have a cap of their own", () => {
    const scripts = Array.from({ length: 60 }, (_, i) => `<script src="/s${i}.js"></script>`).join(
      "",
    );
    const links = Array.from(
      { length: 70 },
      (_, i) => `<link rel="stylesheet" href="/c${i}.css">`,
    ).join("");
    const [home] = buildTechInputs(
      [
        {
          url: "https://example.com/",
          headers: {},
          html: `<html><head>${links}${scripts}</head></html>`,
        },
      ],
      [],
    );
    const urls = home?.scripts?.map((s) => s.url) ?? [];
    for (let i = 0; i < 60; i++) expect(urls).toContain(`/s${i}.js`);
    expect(urls.filter((u) => u.endsWith(".css"))).toHaveLength(40);
    expect(urls.slice(0, 60).every((u) => u.endsWith(".js"))).toBe(true);
  });

  test("WooCommerce CSS listed last among 70 stylesheets is still detected (platform paths first)", () => {
    const links = Array.from(
      { length: 70 },
      (_, i) => `<link rel="stylesheet" href="/builder/c${i}.css">`,
    ).join("");
    const woo = `<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">`;
    const html = `<html><head>${links}${woo}<script src="/app.js"></script></head></html>`;
    const inputs = buildTechInputs([{ url: "https://example.com/", headers: {}, html }], []);
    expect(detectReportTechnologiesMulti(inputs).items.map((t) => t.id)).toContain("woocommerce");
  });

  test("a glued self-closing slash on an unquoted rel still lists the href", () => {
    expect(extractLinkAssetHrefs(`<link href=/a.css rel=stylesheet/>`)).toEqual(["/a.css"]);
  });

  test("a stylesheet named only in prose or a code sample is not listed", () => {
    const prose = `<html><body><p>Load /wp-content/plugins/woocommerce/x.css</p><pre>&lt;link rel="stylesheet" href="/wp-content/plugins/woocommerce/x.css"&gt;</pre><script src="/app.js"></script></body></html>`;
    const [home] = buildTechInputs([{ url: "https://example.com/", headers: {}, html: prose }], []);
    expect(home?.scripts?.map((s) => s.url)).toEqual(["/app.js"]);
  });
});
