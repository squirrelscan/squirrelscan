// #1456: signatures that read a tag's attribute (a script `src`, a `link href`, a `data-*` flag) read one parsed list of
// the page's tags instead of each scanning the HTML for `<script\s`, `<link\b`: the same answers on real markup, plus
// the unquoted and late-attribute forms the bounded scans missed, and a page of unclosed openers costs seconds, not
// minutes. Synthetic fixtures.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { assertCollectedTags } from "../src/collected-tags";

const page = (head: string, body = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const ids = (html: string, scripts?: Array<{ url: string; content?: string }>): string[] =>
  detectTechnologies({ url: "https://example.com/", headers: {}, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
const BODIES = [{ url: "https://example.com/app.js", content: "var a=1;" }];

describe("script src signatures", () => {
  test("quoted, single-quoted and unquoted src; a src after a long run of other attributes", () => {
    const long = Array.from({ length: 80 }, (_, i) => `data-k${i}="v${i}"`).join(" ");
    for (const tag of [
      '<script src="https://cdn.gpteng.co/lovable.js"></script>',
      "<script src='https://cdn.gpteng.co/lovable.js'></script>",
      "<script src=https://cdn.gpteng.co/lovable.js></script>",
      `<script ${long} src="https://cdn.gpteng.co/lovable.js"></script>`,
      '<SCRIPT SRC="https://cdn.gpteng.co/lovable.js"></SCRIPT>',
    ]) {
      expect(ids(page(tag)), tag).toContain("lovable");
      expect(ids(page(tag), BODIES), tag).toContain("lovable");
    }
  });

  test("a commented-out tag, data-src, an anchor and prose are not a script", () => {
    for (const html of [
      page('<!-- <script src="https://cdn.gpteng.co/lovable.js"></script> -->'),
      page('<script data-src="https://cdn.gpteng.co/lovable.js"></script>'),
      page("", '<a href="https://cdn.gpteng.co/lovable.js">x</a><p>https://cdn.gpteng.co/lovable.js</p>'),
    ]) {
      expect(ids(html)).not.toContain("lovable");
      expect(ids(html, BODIES)).not.toContain("lovable");
    }
  });
});

describe("resource attributes and data attributes", () => {
  test("a stylesheet link and a srcset token", () => {
    expect(ids(page('<link rel="stylesheet" href="https://cdn.example.net/css/bulma.min.css">'))).toContain("bulma");
    expect(ids(page('<link href="/static/bulma.css" rel="stylesheet">'))).toContain("bulma");
  });

  test("a link is not an anchor", () => {
    expect(ids(page("", '<a href="/css/bulma.min.css">x</a>'))).not.toContain("bulma");
  });

  test("a script's data attribute flags (Clerk, RequireJS)", () => {
    expect(ids(page('<script data-clerk-js-script src="/c.js"></script>'))).toContain("clerk");
    expect(ids(page('<script data-clerk-publishable-key="pk_test_abc" src="/c.js"></script>'))).toContain("clerk");
    expect(ids(page('<script data-main="js/app" src="require.js"></script>'))).toContain("requirejs");
    expect(ids(page('<script data-clerk-publishable-key="nope" src="/c.js"></script>'))).not.toContain("clerk");
  });

  test("Meta Pixel by its script src", () => {
    expect(ids(page('<script async src="https://connect.facebook.net/en_US/fbevents.js"></script>'))).toContain("facebook-pixel");
  });
});

test("a tag-attr detector on a tag the page pass does not collect is refused where it is built", () => {
  expect(() => assertCollectedTags(["script", "link"])).not.toThrow();
  expect(() => assertCollectedTags(["a"])).toThrow(/does not collect/);
});

describe("hostile pages (5 MB)", () => {
  const rep = (unit: string): string => page("", unit.repeat(Math.ceil(5_000_000 / unit.length)));
  for (const tag of ["script", "link", "img", "iframe"]) {
    for (const [label, unit] of [["unclosed openers", `<${tag} `], ["unbalanced quotes", `<${tag} x="`]] as const) {
      test(`${tag}: ${label}`, () => {
        const html = rep(unit);
        const started = performance.now();
        ids(html);
        // Minutes before the change (every signature rescanned 400 characters after each opener); seconds now.
        expect(performance.now() - started).toBeLessThan(6_000);
      }, 120_000);
    }
  }
});
