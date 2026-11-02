// #1539: the URLs an import map maps to are script URLs: a library loaded as an ES module through `<script type="importmap">` is
// detected like the same library in a `<script src>`. An inline module's static or dynamic import of a URL already counts (its text
// is read). A URL in a CSP, an anchor, JSON-LD, a JSON data script, prose or the keys of an import map still does not. Synthetic pages.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { pageImportMapSkipped, pageMarkup } from "../src/detect";

const page = (head: string, body = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ids = (html: string, url = "https://example.com/"): string[] => detectTechnologies({ url, headers: {}, html }).map((t) => t.id);
const importmap = (imports: Record<string, string>, extra: Record<string, unknown> = {}): string =>
  `<script type="importmap">${JSON.stringify({ imports, ...extra })}</script>`;

const THREE = "three.module.js";
const HOSTS = [
  `https://cdn.jsdelivr.net/npm/three@0.160.0/build/${THREE}`,
  `https://unpkg.com/three@0.160.0/build/${THREE}`,
  `https://cdnjs.cloudflare.com/ajax/libs/three.js/r160/${THREE}`,
  `./vendor/three/build/${THREE}`,
  `/static/js/three/${THREE}`,
];

describe("an import map that maps a specifier to a library URL", () => {
  test("three.js through jsdelivr, unpkg, cdnjs and a self-hosted path", () => {
    for (const url of HOSTS) {
      expect([url, ids(page(importmap({ three: url, "three/addons/": url.replace(THREE, "../examples/jsm/") })))]).toEqual([url, expect.arrayContaining(["threejs"])]);
    }
  });

  test("the scopes table counts too, and an import map in the body", () => {
    expect(ids(page(importmap({ app: "./app.js" }, { scopes: { "/lib/": { three: HOSTS[0] } } })))).toContain("threejs");
    expect(ids(page("", importmap({ three: HOSTS[1] })))).toContain("threejs");
  });

  test("an import map finds what the same URL finds in a script src", () => {
    for (const url of [
      "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
      "https://unpkg.com/three@0.160.0/build/three.module.js",
      "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
      "https://connect.facebook.net/en_US/fbevents.js",
    ]) {
      const viaTag = ids(page(`<script type="module" src="${url}"></script>`));
      const viaMap = ids(page(importmap({ lib: url })));
      expect([url, viaTag.length > 0, viaMap]).toEqual([url, true, expect.arrayContaining(viaTag)]);
    }
  });

  test("an uppercase type, extra attributes and several maps", () => {
    expect(ids(page(`<script TYPE="ImportMap" nonce="x">${JSON.stringify({ imports: { three: HOSTS[0] } })}</script>`))).toContain("threejs");
    expect(ids(page(importmap({ a: "./a.js" }) + importmap({ three: HOSTS[0] })))).toContain("threejs");
  });
});

describe("an inline module that imports a URL", () => {
  test("a static import, a namespace import and a dynamic import()", () => {
    for (const code of [
      `import * as THREE from '${HOSTS[0]}';\nconst scene = new THREE.Scene();`,
      `import { Scene } from "${HOSTS[1]}";`,
      `const THREE = await import('${HOSTS[0]}');`,
    ]) {
      expect(ids(page(`<script type="module">${code}</script>`))).toContain("threejs");
    }
  });
});

describe("what is still not a script URL", () => {
  const url = HOSTS[0]!;
  test("a CSP meta, an anchor, JSON-LD, a JSON data script and prose", () => {
    for (const html of [
      page(`<meta http-equiv="Content-Security-Policy" content="script-src https://cdn.jsdelivr.net/npm/three@0.160.0/ 'self'">`),
      page("", `<a href="${url}">three</a>`),
      page(`<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", url })}</script>`),
      page(`<script type="application/json">${JSON.stringify({ imports: { three: url } })}</script>`),
      page(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { imports: { three: url } } })}</script>`),
      page("", `<p>Load it from ${url} in your page.</p>`),
      page(`<script type="speculationrules">${JSON.stringify({ prefetch: [{ urls: [url] }] })}</script>`),
    ]) {
      expect(ids(html)).not.toContain("threejs");
    }
  });

  test("an import map's keys, a malformed map, a map with no imports and non-string values", () => {
    expect(ids(page(importmap({ [url]: "./local.js" })))).not.toContain("threejs");
    expect(ids(page(`<script type="importmap">{"imports":{"three":"${url}"</script>`))).not.toContain("threejs");
    expect(ids(page(`<script type="importmap">${JSON.stringify({ other: { three: url } })}</script>`))).not.toContain("threejs");
    expect(ids(page(`<script type="importmap">${JSON.stringify({ imports: { three: [url], x: 5, y: null } })}</script>`))).not.toContain("threejs");
    expect(ids(page(`<script type="importmap">[ "${url}" ]</script>`))).not.toContain("threejs");
  });

  test("an import map that maps to other libraries is not three.js", () => {
    expect(ids(page(importmap({ app: "./app.js", lodash: "https://cdn.jsdelivr.net/npm/lodash-es@4/lodash.js" })))).not.toContain("threejs");
  });
});

const SYNTHETIC = '<script type="module" src="';
const synthetic = (html: string): number => pageMarkup(html).split(SYNTHETIC).length - 1;

describe("bounds", () => {
  test("a map of over 64 KB, the 65th URL of a map and a URL over 2,048 characters are not read; each is counted", () => {
    const big = page(importmap({ pad: "x".repeat(70_000), three: HOSTS[0]! }));
    expect(ids(big)).not.toContain("threejs");
    expect(pageImportMapSkipped(big)).toBe(1);
    const sixtyFour: Record<string, string> = {};
    for (let i = 0; i < 63; i++) sixtyFour[`k${i}`] = `./m${i}.js`;
    expect(ids(page(importmap({ ...sixtyFour, three: HOSTS[0]! })))).toContain("threejs");
    const sixtyFive = page(importmap({ ...sixtyFour, k63: "./m63.js", three: HOSTS[0]! }));
    expect(ids(sixtyFive)).not.toContain("threejs");
    expect(synthetic(sixtyFive)).toBe(64);
    expect(pageImportMapSkipped(sixtyFive)).toBe(1);
    const long = page(importmap({ three: `${HOSTS[0]}?${"a".repeat(2_100)}` }));
    expect(ids(long)).not.toContain("threejs");
    expect(pageImportMapSkipped(long)).toBe(1);
  });

  test("at most 512 URLs a page: 9 maps of 64, the 513th and later are counted", () => {
    const maps = Array.from({ length: 9 }, (_, m) => importmap(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, `./m${m}-${i}.js`])))).join("");
    const html = page(maps);
    expect(synthetic(html)).toBe(512);
    expect(pageImportMapSkipped(html)).toBe(64);
  });

  test("at most 64 KB of synthetic tags a page: 2,000-character URLs stop at the byte bound", () => {
    const url = (i: number) => `./${"d".repeat(1_990)}${i}.js`;
    const maps = Array.from({ length: 3 }, (_, m) => importmap(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, url(m * 30 + i)])))).join("");
    const html = page(maps);
    const count = synthetic(html);
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThan(40);
    expect(count * 2_030).toBeLessThanOrEqual(64 * 1024 + 2_030);
    expect(pageImportMapSkipped(html)).toBe(90 - count);
  });
});

describe("a URL cannot forge a tag", () => {
  const forged = [
    '"><script src=//evil-three.example/three.js>',
    '"><img src=x onerror=1><script src="https://evil-three.example/three.module.js',
    "https://cdn.example.net/a.js\nthree.module.js",
    "https://cdn.example.net/a.js\n<script src=//evil-three.example/three.js>",
    "https://cdn.example.net/a b/three.module.js",
    "https://cdn.example.net/'three.module.js",
    "https://cdn.example.net/`three.module.js",
    "https://cdn.example.net/<three.module.js>",
    "https://cdn.example.net/\\three.module.js",
    "javascript:three.module.js",
    "data:text/javascript,three.module.js",
    "blob:https://example.com/three.module.js",
  ];
  test("a quote, bracket, backtick, backslash, whitespace, control character or a scheme other than http(s) is skipped and counted", () => {
    for (const url of forged) {
      const html = page(importmap({ lib: url }));
      expect([url, synthetic(html), pageImportMapSkipped(html), ids(html).includes("threejs")]).toEqual([url, 0, 1, false]);
      expect(pageMarkup(html)).not.toContain("evil-three");
    }
    // a newline written as the JSON escape is a newline in the string, and is rejected too
    const raw = `<script type="importmap">{"imports":{"lib":"https://cdn.example.net/a.js\\n<script src=//evil-three.example/three.js>"}}</script>`;
    expect(synthetic(page(raw))).toBe(0);
  });

  test("a good URL next to forged ones is the only synthetic tag, as exactly one well-formed script tag", () => {
    const html = page(importmap({ a: forged[0]!, three: HOSTS[0]!, b: forged[3]! }));
    expect(synthetic(html)).toBe(1);
    expect(pageMarkup(html)).toContain(`${SYNTHETIC}${HOSTS[0]}"></script>`);
    expect(ids(html)).toContain("threejs");
  });

  test("http, https, protocol-relative and relative URLs are kept", () => {
    const html = page(importmap({ a: "http://cdn.example.net/a.js", b: "https://cdn.example.net/b.js", c: "//cdn.example.net/c.js", d: "./d.js", e: "../e.js", f: "/f.js", g: "g.js" }));
    expect(synthetic(html)).toBe(7);
    expect(pageImportMapSkipped(html)).toBe(0);
  });
});

describe("hostile pages (5 MB), counted not timed", () => {
  const time = (html: string): number => {
    const started = performance.now();
    ids(html);
    return performance.now() - started;
  };

  test("one map with 100,000 entries, and one 5 MB map: over the size bound, skipped, no tag", () => {
    const entries = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, `./m${i}.js`]));
    const huge = page(importmap(entries));
    expect(huge.length).toBeGreaterThan(1_500_000);
    expect(synthetic(huge)).toBe(0);
    expect(pageImportMapSkipped(huge)).toBe(1);
    const five = page(importmap({ pad: "x".repeat(5_000_000) }));
    expect(synthetic(five)).toBe(0);
    expect(pageImportMapSkipped(five)).toBe(1);
    expect(time(huge)).toBeLessThan(10_000);
    expect(time(five)).toBeLessThan(10_000);
  }, 120_000);

  test("100,000 tiny maps: 512 URLs are read, the rest counted, and the markup holds 512 synthetic tags at most", () => {
    const unit = importmap({ a: "./a.js" });
    const html = page(unit.repeat(100_000));
    expect(html.length).toBeGreaterThan(5_000_000);
    expect(synthetic(html)).toBe(512);
    expect(pageImportMapSkipped(html)).toBe(100_000 - 512);
    expect(time(html)).toBeLessThan(15_000);
  }, 120_000);

  test("deep scopes: 200 scopes of 5 URLs in one map read the first 64 and count the rest", () => {
    const scopes: Record<string, Record<string, string>> = {};
    for (let s = 0; s < 200; s++) scopes[`/s${s}/`] = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, `./s${s}-${i}.js`]));
    const html = page(`<script type="importmap">${JSON.stringify({ scopes })}</script>`);
    expect(html.length).toBeLessThan(64 * 1024 + 2_000);
    expect(synthetic(html)).toBe(64);
    expect(pageImportMapSkipped(html)).toBe(1_000 - 64);
  });
});

describe("scopes, templates and entries the page never imports", () => {
  const url = HOSTS[0]!;
  test("a map with only a scopes table counts: scoped mappings are real", () => {
    expect(ids(page(`<script type="importmap">${JSON.stringify({ scopes: { "/a/": { three: url } } })}</script>`))).toContain("threejs");
  });

  test("a map entry the page never imports still counts (evidence, not proof)", () => {
    expect(ids(page(importmap({ three: url }), "<p>no module script here</p>"))).toContain("threejs");
  });

  test("a map inside a template is inert and is not read, nested templates included; the same map after the template is", () => {
    const map = importmap({ three: url });
    expect(ids(page(`<template>${map}</template>`))).not.toContain("threejs");
    expect(ids(page(`<template><div><template>${map}</template>${map}</div></template>`))).not.toContain("threejs");
    expect(ids(page(`<template><p>x</p></template>${map}`))).toContain("threejs");
    expect(ids(page(`<template></template><template>${map}</template>`))).not.toContain("threejs");
    expect(ids(page(`<TEMPLATE id=a>${map}</TEMPLATE>${map}`))).toContain("threejs");
    expect(synthetic(page(`<template>${map}</template>`))).toBe(0);
  });
});

describe("precision", () => {
  test("the word importmap in prose or a comment, JSON outside an importmap script, and a map of other vendors", () => {
    for (const html of [
      page("", `<p>Use an importmap: {"imports":{"three":"${HOSTS[0]}"}}</p>`),
      page("<!-- <script type=\"importmap\">" + JSON.stringify({ imports: { three: HOSTS[0] } }) + "</script> -->"),
      page(`<div data-importmap='${JSON.stringify({ imports: { three: HOSTS[0] } })}'></div>`),
      page(`<script type="application/importmap+json">${JSON.stringify({ imports: { three: HOSTS[0] } })}</script>`.replace("application/importmap+json", "application/json")),
      page(importmap({ lodash: "https://cdn.jsdelivr.net/npm/lodash-es@4/lodash.js", app: "./app.js" })),
    ]) {
      expect(ids(html)).not.toContain("threejs");
    }
  });
});
