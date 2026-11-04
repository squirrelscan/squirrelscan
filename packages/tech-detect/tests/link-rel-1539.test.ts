// #1539: a `<link>` is vendor evidence only when its `rel` loads the resource it names (stylesheet, preload, modulepreload,
// prefetch, prerender) or opens a connection to a service's origin (preconnect, dns-prefetch). canonical, alternate, author, license, icon, next and the like only describe or
// relate a URL: a vendor URL there is not a vendor loaded. Synthetic pages.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const page = (head: string) => `<!doctype html><html><head><title>t</title>${head}</head><body></body></html>`;
// The `html` detectors (a CDN host written anywhere on the page, such as `jsdelivr`) read the raw page on purpose and are not
// in question here: only the library the URL names counts, so the ids are those of the script-url and tag-attr detectors.
const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id).filter((id) => id !== "jsdelivr");
const THREE = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const link = (rel: string, href = THREE, order: "rel-first" | "href-first" = "rel-first"): string =>
  order === "rel-first" ? `<link rel="${rel}" href="${href}">` : `<link href="${href}" rel="${rel}">`;

describe("a link that only describes or relates a URL is not a vendor loaded", () => {
  test("canonical, alternate, author, license, help, next, prev, icon and manifest", () => {
    for (const rel of ["canonical", "alternate", "author", "license", "help", "next", "prev", "icon", "apple-touch-icon", "me", "manifest", "search", "alternate stylesheet-less", ""]) {
      for (const order of ["rel-first", "href-first"] as const) {
        expect([rel, order, ids(page(link(rel, THREE, order)))]).toEqual([rel, order, []]);
      }
    }
    expect(ids(page(`<link href="${THREE}">`))).toEqual([]);
  });

  test("a missing rel, an unquoted rel and a rel with other tokens around the describing one", () => {
    expect(ids(page(`<link rel=canonical href="${THREE}">`))).toEqual([]);
    expect(ids(page(`<link rel="  Canonical  alternate " href="${THREE}">`))).toEqual([]);
  });
});

describe("a link that loads its resource still counts", () => {
  test("stylesheet, preload, modulepreload, prefetch, prerender, preconnect and dns-prefetch, in either attribute order, any case, among other tokens", () => {
    for (const rel of ["stylesheet", "preload", "modulepreload", "prefetch", "prerender", "preconnect", "dns-prefetch", "MODULEPRELOAD", "  preload  ", "alternate stylesheet", "preload prefetch"]) {
      for (const order of ["rel-first", "href-first"] as const) {
        expect([rel, order, ids(page(link(rel, THREE, order)))]).toEqual([rel, order, expect.arrayContaining(["threejs"])]);
      }
    }
    expect(ids(page(`<link rel=modulepreload href="${THREE}">`))).toContain("threejs");
  });

  test("a stylesheet detector still reads its link, and a describing link beside a real script src does not hide it", () => {
    expect(ids(page(`<link rel="stylesheet" href="https://example.com/css/bulma.min.css">`))).toContain("bulma");
    expect(ids(page(link("canonical") + `<script type="module" src="${THREE}"></script>`))).toContain("threejs");
  });
});

describe("a long rel is read in whole tokens, never cut mid-token", () => {
  test("a stylesheet token after 128 other tokens still loads; a near-miss token at the old cut does not", () => {
    expect(ids(page(link(`${"x ".repeat(128)}stylesheet`)))).toEqual(ids(page(link("stylesheet"))));
    expect(ids(page(link(`${"x ".repeat(123)}stylesheet-nope`)))).toEqual([]);
  }, 30_000);
});
