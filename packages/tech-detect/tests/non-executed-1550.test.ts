// #1550: a vendor URL or tag that only sits in content a browser neither runs nor shows (the text of a JSON, JSON-LD or
// import-map script, a `<template>`, an HTML comment) is not a detection. A marker comment a fingerprint matches on purpose
// (a WordPress plugin banner), CSS in `<style>` and real tags outside those regions still are. Where the pass cannot prove
// where a region ends (no `-->`, no `</template>`, an over-long tag) the text stays: the old behaviour, not a lost detection.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";

const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const page = (body: string, head = ""): string => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const YT = '<iframe src="https://www.youtube.com/embed/abc"></iframe>';
const STRIPE_TAG = '<script src="https://js.stripe.com/v3/"></script>';
const FONT_CSS = "@import url(https://fonts.googleapis.com/css2?family=Inter);";
/** A JSON string a page can put in a script: `</` is escaped, or the string would end the script. */
const json = (s: string): string => JSON.stringify(s).replaceAll("</", "<\\/");

describe("data script bodies", () => {
  for (const type of ["application/json", "application/ld+json", "importmap", "speculationrules", "text/x-template", "text/html"]) {
    test(`${type}: markup written as a string in it is not detected`, () => {
      const body = `<script type="${type}">{"x":${json(`${STRIPE_TAG}${YT}`)}}</script>`;
      expect(ids(page(body))).not.toContain("stripe");
      expect(ids(page(body))).not.toContain("youtube-embed");
    });
  }
  test("the same markup in the live page is detected", () => {
    expect(ids(page(`${STRIPE_TAG}${YT}`))).toEqual(expect.arrayContaining(["stripe", "youtube-embed"]));
  });
  test("an inline JavaScript script keeps its text", () => {
    expect(ids(page(`<script>document.write(${json(YT)})</script>`))).toContain("youtube-embed");
    expect(ids(page(`<script type="module">document.write(${json(YT)})</script>`))).toContain("youtube-embed");
  });
  test("the first type attribute wins, and a type inside another attribute's value is not the type", () => {
    expect(ids(page(`<script type="text/javascript" type="application/json">document.write(${json(YT)})</script>`))).toContain("youtube-embed");
    expect(ids(page(`<script data-x=' type="application/json"'>document.write(${json(YT)})</script>`))).toContain("youtube-embed");
  });
  test("a data script that never closes is kept", () => {
    expect(ids(page(`<script type="application/json">{"a":${json(YT)}}`))).toContain("youtube-embed");
  });
  test("an import map still yields its URLs as script URLs (#1539)", () => {
    const map = '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script>';
    expect(ids(page(map))).toContain("threejs");
  });
});

describe("template content", () => {
  test("a script, an iframe and an html match inside a template are not detected", () => {
    const html = page(`<template>${STRIPE_TAG}${YT}</template>`);
    expect(ids(html)).not.toContain("stripe");
    expect(ids(html)).not.toContain("youtube-embed");
  });
  test("what follows the template is read", () => {
    expect(ids(page(`<template><p>x</p></template>${YT}`))).toContain("youtube-embed");
  });
  test("nested templates pair innermost first", () => {
    expect(ids(page(`<template><template><p>x</p></template>${YT}</template>`))).not.toContain("youtube-embed");
    expect(ids(page(`<template><template><p>x</p></template></template>${YT}`))).toContain("youtube-embed");
  });
  test("the word template in a script string, a textarea, a comment or an attribute pairs with nothing", () => {
    expect(ids(page(`<script>var a = "<template>";</script>${YT}<script>var b = "</template>";</script>`))).toContain("youtube-embed");
    expect(ids(page(`<textarea><template></textarea>${YT}<textarea></template></textarea>`))).toContain("youtube-embed");
    expect(ids(page(`<!-- <template> -->${YT}<!-- </template> -->`))).toContain("youtube-embed");
    expect(ids(page(`<div data-a="<template>">${YT}</div><div data-b="</template>"></div>`))).toContain("youtube-embed");
  });
  test("a template that never closes, and a longer tag name, cut nothing", () => {
    expect(ids(page(`<template><p>x</p>${YT}`))).toContain("youtube-embed");
    expect(ids(page(`<templates>${YT}</templates>`))).toContain("youtube-embed");
    expect(ids(page(`<template-x>${YT}</template-x>`))).toContain("youtube-embed");
  });
  test("a self-closing template tag opens nothing", () => {
    expect(ids(page(`<template/>${YT}`))).toContain("youtube-embed");
  });
  test("a declarative shadow root is rendered, so it is read, but it pairs and cannot steal an outer template's end", () => {
    expect(ids(page(`<div><template shadowrootmode="open">${YT}</template></div>`))).toContain("youtube-embed");
    expect(ids(page(`<template><template shadowrootmode="open"><p>x</p></template></template>${YT}`))).toContain("youtube-embed");
  });
});

describe("comments", () => {
  test("a commented-out tag or loader is not detected", () => {
    expect(ids(page(`<!-- ${YT} -->`))).not.toContain("youtube-embed");
    expect(ids(page(`<!-- ${STRIPE_TAG} -->`))).not.toContain("stripe");
  });
  test("a comment ends at --> or --!>, and <!--> and <!---> are empty comments", () => {
    expect(ids(page(`<!-- x --!>${YT}`))).toContain("youtube-embed");
    expect(ids(page(`<!-->${YT}<!-- y -->`))).toContain("youtube-embed");
    expect(ids(page(`<!--->${YT}<!-- y -->`))).toContain("youtube-embed");
  });
  test("a comment that never ends stays as written", () => {
    expect(ids(page(`<!-- ${YT}`))).toContain("youtube-embed");
  });
  test("a comment marker a fingerprint matches on purpose still detects", () => {
    expect(ids(page("<p>x</p>", "<!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me -->"))).toContain("wp-rocket");
    expect(ids(page('<svg><!--!Font Awesome Free 6.5.1 by @fontawesome - https://fontawesome.com License--><path d="M0 0"/></svg>'))).toContain("font-awesome");
  });
  test("`<!--` inside a script string or a style opens no comment", () => {
    expect(ids(page(`<script>var a = "<!--";</script>${YT}<script>var b = "-->";</script>`))).toContain("youtube-embed");
    expect(ids(page(`<style>/* <!-- */</style>${YT}<style>/* --> */</style>`))).toContain("youtube-embed");
  });
});

describe("what stays evidence", () => {
  test("CSS in a style element", () => {
    expect(ids(page("<p>x</p>", `<style>${FONT_CSS}</style>`))).toContain("google-fonts");
  });
  test("a real script src and an inline loader outside the regions, beside inert ones", () => {
    const html = page(`<template>${YT}</template><!-- ${YT} -->${STRIPE_TAG}<script type="application/json">{}</script>`);
    expect(ids(html)).toContain("stripe");
    expect(ids(html)).not.toContain("youtube-embed");
  });
  test("a vendor URL in a textarea is not cut (no pair was seen in this region)", () => {
    expect(ids(page(`<textarea>${YT}</textarea>`))).toContain("youtube-embed");
  });
});

describe("bounds", () => {
  test("a tag over 64 KB stops the cutting: the rest of the page stays", () => {
    const longTag = `<div data-x="${"a".repeat(70_000)}">`;
    expect(ids(page(`${longTag}<!-- ${YT} -->`))).toContain("youtube-embed");
    expect(ids(page(`<!-- ${YT} -->`))).not.toContain("youtube-embed");
  });
  test("hostile inputs stay linear", () => {
    const shapes: Record<string, string> = {
      "unclosed templates": "<template>".repeat(100_000),
      "unclosed styles": "<style>".repeat(100_000),
      "unclosed textareas": "<textarea>".repeat(100_000),
      "comments": "<!-- a -->".repeat(100_000),
      "empty comments": "<!-->".repeat(100_000),
      "data scripts": '<script type="application/json">{}</script>'.repeat(50_000),
      "template pairs": "<template></template>".repeat(100_000),
      "deep templates": "<template>".repeat(50_000) + "</template>".repeat(50_000),
    };
    for (const [name, body] of Object.entries(shapes)) {
      const started = performance.now();
      ids(page(body));
      expect(performance.now() - started, name).toBeLessThan(4_000);
    }
  }, 60_000);
});
