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

  test("a stylesheet named only in prose or a code sample is not listed", () => {
    const prose = `<html><body><p>Load /wp-content/plugins/woocommerce/x.css</p><pre>&lt;link rel="stylesheet" href="/wp-content/plugins/woocommerce/x.css"&gt;</pre><script src="/app.js"></script></body></html>`;
    const [home] = buildTechInputs([{ url: "https://example.com/", headers: {}, html: prose }], []);
    expect(home?.scripts?.map((s) => s.url)).toEqual(["/app.js"]);
  });
});
