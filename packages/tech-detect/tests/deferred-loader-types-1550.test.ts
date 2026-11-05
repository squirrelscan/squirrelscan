// #1550 follow-up: a delay or consent plugin parks a real loader in a script type the browser does not run, and the page runs it
// later. Those wrapper types stay evidence (a Clarity or GTM loader in one detects); JSON, JSON-LD, import maps, templates and
// comments stay cut. Wrapper names are an explicit list, the ones the plugins write: WP Rocket, Perfmatters, NitroPack, SiteGround Optimizer,
// Cloudflare Rocket Loader, a cookie-consent blocker, Babel standalone, and delay plugins seen in the PH corpus.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { pageImportMapSkipped, scriptTypeRuns } from "../src/detect";

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
  "consent and delay tools seen in the corpus": ["easyoptscript", "application/x-imovisor-consent", "EasyOptScript"],
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

// `__bundler/ext_resources` is a JSON list a standalone-HTML bundler loads scripts from. It is data like an import map: only the
// `uri`, `url` and (the corpus shape) `id` fields are script URLs; a description or any other text in the list stays inert.
describe("a bundler's ext_resources list is read like an import map", () => {
  const BUNDLER = "__bundler/ext_resources";
  const THREE = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  const list = (body: string): string => wrap(BUNDLER, body);
  test("it is data, not a running type", () => {
    expect(scriptTypeRuns(BUNDLER)).toBe(false);
  });
  test("the exact Codex fixture: a vendor URL in a description is not a detection, the local script is the only one loaded", () => {
    const found = ids(list('[{"id":"a","uri":"./local.js","description":"See https://www.youtube.com/embed/abc for instructions"}]'));
    expect(found).not.toContain("youtube-embed");
    expect(found).not.toContain("clarity");
  });
  test("a vendor script in a uri or url field is detected (the corpus shape: an array of objects with a uri)", () => {
    expect(ids(list(`[{"id":"a","uri":"${THREE}"}]`))).toContain("threejs");
    expect(ids(list(`[{"id":"a","url":"${THREE}"}]`))).toContain("threejs");
    const corpus = list(
      JSON.stringify([
        { id: "clarity", uri: "https://www.clarity.ms/tag/abc", description: "See https://www.youtube.com/embed/abc" },
        { id: "gtm", uri: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123", integrity: "sha384-x" },
        { id: "local", uri: "./local.js" },
      ]),
    );
    const found = ids(corpus);
    expect(found).toContain("clarity");
    expect(found).toContain("google-tag-manager");
    expect(found).not.toContain("youtube-embed");
    expect(ids(wrap("__BUNDLER/EXT_RESOURCES", `[{"uri":"${THREE}"}]`))).toContain("threejs");
  });
  test("the corpus shape: an id that is the script URL and a uuid, an array of objects with exactly those two keys", () => {
    const UUID = "0b1f9c1e-7d3a-4c55-9a1e-2f4d6b8c0e11";
    expect(ids(list(`[{"id":"${THREE}","uuid":"${UUID}"}]`))).toContain("threejs");
    expect(ids(list(`[{"id":"https://unpkg.com/react@18.2.0/umd/react.production.min.js","uuid":"${UUID}"}]`))).toContain("react");
    const found = ids(list(`[{"id":"https://www.clarity.ms/tag/abc","uuid":"${UUID}"}]`));
    expect(found).toContain("clarity");
    // a mixed list: URL ids are read, bare token ids and a uuid are not, and a relative path loads nothing a vendor owns
    const mixed = ids(
      list(
        JSON.stringify([
          { id: "https://www.clarity.ms/tag/abc", uuid: UUID },
          { id: "a", uuid: "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123" },
          { id: UUID, uuid: UUID },
          { id: "./local.js", uuid: UUID },
          { id: THREE, uuid: UUID },
        ]),
      ),
    );
    expect(mixed).toContain("clarity");
    expect(mixed).toContain("threejs");
    expect(mixed).not.toContain("google-tag-manager");
  });
  test("an id that is not an address, and a uuid or description holding a URL, are inert", () => {
    for (const body of [
      '[{"id":"a","uuid":"0b1f9c1e-7d3a-4c55-9a1e-2f4d6b8c0e11"}]',
      '[{"id":"0b1f9c1e-7d3a-4c55-9a1e-2f4d6b8c0e11","uuid":"0b1f9c1e-7d3a-4c55-9a1e-2f4d6b8c0e11"}]',
      `[{"id":"a","uuid":"${THREE}"}]`,
      `[{"id":"a","uuid":"x","description":"${THREE}"}]`,
      `[{"id":"three.module.js","uuid":"x"},{"id":"data:text/javascript,1","uuid":"x"},{"id":"${THREE} onload=x","uuid":"x"},{"id":"${THREE}\"><b>","uuid":"x"}]`,
    ]) {
      expect([body, ids(list(body))]).toEqual([body, []]);
    }
  });
  test("an id URL over the bounds is skipped and counted, a token id is not counted", () => {
    expect(pageImportMapSkipped(list(`[{"id":"https://a.test/${"x".repeat(2_100)}","uuid":"x"}]`))).toBe(1);
    expect(pageImportMapSkipped(list('[{"id":"a","uuid":"x"},{"id":"b","uuid":"y"}]'))).toBe(0);
    const entry = (i: number): string => `{"id":"https://cdn.example.com/a${i}.js","uuid":"x"}`;
    expect(pageImportMapSkipped(list(`[${Array.from({ length: 1_000 }, (_, i) => entry(i)).join(",")}]`))).toBe(1_000 - 256);
    expect(pageImportMapSkipped(list(`[${Array.from({ length: 4_000 }, (_, i) => entry(i)).join(",")}]`))).toBe(1);
  }, 30_000);
  test("every other field, a non-list shape, a bare name and an unsafe value stay inert", () => {
    for (const body of [
      `[{"src":"${THREE}","href":"${THREE}","name":"${THREE}","uuid":"${THREE}"}]`,
      `[{"id":"a","uuid":"${THREE}"},{"id":"0b1f9c1e-7d3a-4c55-9a1e-2f4d6b8c0e11","uuid":"${THREE}"}]`,
      `{"uri":"${THREE}"}`,
      `{"resources":[{"uri":"${THREE}"}]}`,
      `[["${THREE}"],"${THREE}",null,1,{"uri":5,"url":["${THREE}"]}]`,
      '[{"uri":"three.module.js"},{"uri":"data:text/javascript,1"},{"uri":"javascript:alert(1)"}]',
      `[{"uri":"${THREE} onload=x"},{"uri":"https://a.test/\"><script src=${THREE}>"}]`,
      `[{"uri":"${THREE}"`,
      `not json ${THREE}`,
      "",
    ]) {
      expect([body, ids(list(body))]).toEqual([body, []]);
    }
  });
  test("a list in a template or a comment is not read", () => {
    expect(ids(page(`<template><script type="${BUNDLER}">[{"uri":"${THREE}"}]</script></template>`))).not.toContain("threejs");
    expect(ids(page(`<!-- <script type="${BUNDLER}">[{"uri":"${THREE}"}]</script> -->`))).not.toContain("threejs");
  });
  test("bounds: a list over 64 KB is skipped, 256 URLs a list are read, malformed and huge lists are bounded", () => {
    const entry = (i: number): string => `{"uri":"https://cdn.example.com/a${i}.js"}`;
    const big = list(`[${Array.from({ length: 4_000 }, (_, i) => entry(i)).join(",")}]`);
    expect(pageImportMapSkipped(big)).toBe(1);
    const many = list(`[${Array.from({ length: 1_000 }, (_, i) => entry(i)).join(",")}]`);
    expect(pageImportMapSkipped(many)).toBe(1_000 - 256);
    expect(ids(big)).toEqual(ids(page("")));
  }, 30_000);
  test("hostile input stays linear", () => {
    const shapes: Record<string, string> = {
      "many empty lists": `<script type="${BUNDLER}">[]</script>`.repeat(30_000),
      "many one-entry lists": `<script type="${BUNDLER}">[{"uri":"${THREE}"}]</script>`.repeat(5_000),
      "unclosed lists": `<script type="${BUNDLER}">[{"uri":"`.repeat(30_000),
      "deep nesting": `<script type="${BUNDLER}">${"[".repeat(30_000)}</script>`.repeat(5),
      "one huge list": `<script type="${BUNDLER}">[${'{"uri":"https://cdn.example.com/a.js"},'.repeat(200_000)}{}]</script>`,
      "one huge list of ids": `<script type="${BUNDLER}">[${'{"id":"https://cdn.example.com/a.js","uuid":"x"},'.repeat(200_000)}{}]</script>`,
      "long id": `<script type="${BUNDLER}">[{"id":"https://a.test/${"x".repeat(60_000)}","uuid":"x"}]</script>`.repeat(50),
      "long uri": `<script type="${BUNDLER}">[{"uri":"https://a.test/${"x".repeat(60_000)}"}]</script>`.repeat(50),
    };
    for (const [name, body] of Object.entries(shapes)) {
      const started = performance.now();
      ids(page(body));
      expect(performance.now() - started, name).toBeLessThan(4_000);
    }
  }, 30_000);
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
