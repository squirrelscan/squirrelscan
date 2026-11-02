// #1539: the URLs an import map maps to are script URLs: a library loaded as an ES module through `<script type="importmap">` is
// detected like the same library in a `<script src>`. An inline module's static or dynamic import of a URL already counts (its text
// is read). A URL in a CSP, an anchor, JSON-LD, a JSON data script, prose or the keys of an import map still does not. Synthetic pages.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

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

describe("bounds", () => {
  test("a map of over 64 KB, more than 256 URLs and a URL over 2,048 characters are not read past the bound", () => {
    const big = importmap({ pad: "x".repeat(70_000), three: HOSTS[0]! });
    expect(ids(page(big))).not.toContain("threejs");
    const many: Record<string, string> = {};
    for (let i = 0; i < 300; i++) many[`k${i}`] = `./m${i}.js`;
    many.three = HOSTS[0]!;
    expect(ids(page(importmap(many)))).not.toContain("threejs");
    expect(ids(page(importmap({ three: `${HOSTS[0]}?${"a".repeat(2_100)}` })))).not.toContain("threejs");
  });

  test("a 5 MB page of import maps is read in linear time", () => {
    const unit = importmap({ a: "./a.js", b: "https://cdn.example.net/b.js", c: "./c.js" });
    const html = page(unit.repeat(Math.ceil(5_000_000 / unit.length)));
    const started = performance.now();
    ids(html);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 120_000);
});
