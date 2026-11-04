// #1550 follow-up: a delay or consent plugin parks a real loader in a script type the browser does not run, and the page runs it
// later. Those wrapper types stay evidence (a Clarity or GTM loader in one detects); JSON, JSON-LD, import maps, templates and
// comments stay cut. Wrapper names are an explicit list, the ones the plugins write: WP Rocket, Perfmatters, NitroPack, SiteGround Optimizer,
// Cloudflare Rocket Loader, a cookie-consent blocker, Babel standalone, and delay plugins seen in the PH corpus.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { scriptTypeRuns } from "../src/detect";

const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const page = (body: string): string => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const CLARITY = '(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","abcdefghij");';
const GTM = "(function(w,d,s,l,i){var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-ABC123');";
const wrap = (type: string, body: string): string => page(`<script type="${type}">${body}</script>`);
const HASH = "0123456789abcdef0123456789abcdef";

const WRAPPERS: Record<string, string[]> = {
  "WP Rocket": ["rocketlazyloadscript", "text/rocketlazyloadscript"],
  Perfmatters: ["pmdelayedscript"],
  NitroPack: ["nitropack/inlinescript", "nitropack/javascript"],
  "SiteGround Optimizer": ["text/sg-delayed-inline"],
  "delay plugins in the corpus": ["bv_inline_delayed_js", "o/js-lzl", "pslazyscript", "airfleetlazyloadscript", "lazyjs", "text/prosyo-later", "BV_INLINE_DELAYED_JS"],
  "cookie-consent blockers": ["javascript/blocked", "text/javascript-blocked", "text/javascript_blocked", "text/blocked", "application/ecmascript-blocked"],
  "Rocket Loader": [`${HASH}-text/javascript`, `${HASH}-module`, `${HASH}-application/javascript`, "AB12CD34-MODULE"],
  "Babel standalone": ["text/babel"],
  "an existing wrapper (#1435)": ["litespeed/javascript", "text/plain", "text/partytown"],
};

describe("a loader inside a wrapper type is detected", () => {
  for (const [family, types] of Object.entries(WRAPPERS)) {
    for (const type of types) {
      test(`${family}: ${type}`, () => {
        expect(ids(wrap(type, CLARITY))).toContain("clarity");
        expect(ids(wrap(type, GTM))).toContain("google-tag-manager");
        expect(scriptTypeRuns(type)).toBe(true);
      });
    }
  }
  test("the bundler's ext_resources list: its script URLs are read", () => {
    const html = wrap("__bundler/ext_resources", '[{"id":"a","uri":"https://www.clarity.ms/tag/abc"}]');
    expect(ids(html)).toContain("clarity");
  });
});

describe("the same text in data stays cut", () => {
  const DATA_TYPES = [
    "application/json", "application/ld+json", "importmap", "speculationrules", "text/x-template", "text/html", "text/template",
    "text/x-handlebars-template", "text/ng-template", "text/x-jquery-tmpl", "text/css", "text/markdown", "application/x-custom",
    "text/x-custom", "text/jsx", "text/typescript", "text/javascript1.6", "text/javascript;charset=utf-8", "text/javascript; charset=utf-8",
    "application/json+lazyload", "application/lazy-config+json", "application/javascript-template", "text/x-lazy-template", "text/x-handlebars",
    // A custom data type that happens to carry a delay word or a javascript word: a vendor URL held as data in it is not a detection.
    // Only the exact wrapper names read as code, so none of these is one.
    "text/x-lazy-cache", "application/javascript-example",
    "application/x-lazy-config", "text/x-delayed-queue", "text/x-deferred-data", "application/x-defer-config", "text/lazy-data",
    "application/vnd.delayed", "application/x-later-queue", "text/x-blocked-list", "application/blocked", "text/x-lazysizes",
    "application/x-javascript-config", "application/javascript-data", "text/javascript-data", "application/x-ecmascript-config",
    "text/javascript.config", "text/x-delay-settings", "text/x-lazy-state", "text/x-defer-manifest", "text/x-delay-schema", "text/x-lazy-store",
    "TEXT/X-LAZY-CONFIG",
  ];
  for (const type of DATA_TYPES) {
    test(type, () => {
      const found = ids(wrap(type, JSON.stringify({ loader: CLARITY, gtm: GTM })));
      expect(found).not.toContain("clarity");
      expect(found).not.toContain("google-tag-manager");
      expect(scriptTypeRuns(type)).toBe(false);
    });
  }
  test("a name that only contains a wrapper word is not a wrapper: the list is explicit", () => {
    for (const type of ["pmdelayedscript_datalayer", "lazyloadstore", "text/delayed-javascript", "text/lazyload-metadata", "text/x-lazy-cache", "rocketlazyloadscript2", "xpslazyscript", "javascript/blocked-x", "text/javascript-later"]) {
      expect([type, scriptTypeRuns(type)]).toEqual([type, false]);
    }
  });
  test("the exact Codex fixture: a youtube embed and a clarity URL held as data in text/x-lazy-cache are not detected", () => {
    const body = '{"video":"https://www.youtube.com/embed/abc","loader":"https://www.clarity.ms/tag/abc"}';
    for (const type of ["text/x-lazy-cache", "application/javascript-example"]) {
      const found = ids(wrap(type, body));
      expect([type, found.includes("clarity"), found.includes("youtube-embed")]).toEqual([type, false, false]);
    }
  });
  test("a comment and a template holding a wrapper script are cut", () => {
    const wrapped = `<script type="rocketlazyloadscript">${CLARITY}</script>`;
    expect(ids(page(`<!-- ${wrapped} -->`))).not.toContain("clarity");
    expect(ids(page(`<template>${wrapped}</template>`))).not.toContain("clarity");
    expect(ids(page(wrapped))).toContain("clarity");
  });
  test("a wrapper-looking word outside a type is not a type", () => {
    expect(ids(page(`<script type="application/json" data-kind="rocketlazyloadscript">${JSON.stringify(CLARITY)}</script>`))).not.toContain("clarity");
  });
});

describe("the type is trimmed before it is bounded", () => {
  test("more than 2048 spaces before a data type do not turn it into an empty (running) type", () => {
    for (const type of ["application/json", "importmap", "text/x-lazy-config"]) {
      expect([type, scriptTypeRuns(`${" ".repeat(3_000)}${type}`)]).toEqual([type, false]);
      expect([type, scriptTypeRuns(`${"\n\t ".repeat(2_000)}${type}${" ".repeat(3_000)}`)]).toEqual([type, false]);
    }
    expect(scriptTypeRuns(`${" ".repeat(3_000)}text/javascript`)).toBe(true);
    expect(scriptTypeRuns(`${" ".repeat(3_000)}`)).toBe(true);
    const html = wrap(`${" ".repeat(3_000)}application/json`, JSON.stringify({ loader: CLARITY }));
    expect(ids(html)).not.toContain("clarity");
  }, 10_000);
});

describe("hostile input stays linear", () => {
  test("many wrapper and data scripts, and long types", () => {
    const shapes: Record<string, string> = {
      "wrapper scripts": `<script type="rocketlazyloadscript">${CLARITY}</script>`.repeat(2_000),
      "empty wrapper scripts": '<script type="pmdelayedscript"></script>'.repeat(50_000),
      "unclosed wrappers": '<script type="javascript/blocked">'.repeat(50_000),
      "long delay-word type": `<script type="${"lazy".repeat(500)}">x</script>`.repeat(2_000),
      "long separator type": `<script type="${"/".repeat(2_000)}javascript${"-".repeat(2_000)}x">x</script>`.repeat(500),
      "long hash prefix": `<script type="${"a".repeat(2_000)}-module">x</script>`.repeat(2_000),
      "long unmatched type": `<script type="${"x".repeat(60_000)}">x</script>`.repeat(20),
    };
    for (const [name, body] of Object.entries(shapes)) {
      const started = performance.now();
      ids(page(body));
      expect(performance.now() - started, name).toBeLessThan(4_000);
    }
  }, 30_000);
});
