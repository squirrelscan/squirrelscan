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

describe("script types: only what a browser runs is read (HTML spec, checked in Chrome 156)", () => {
  const hit = (attrs: string): boolean => ids(page(`<script${attrs}>document.write(${json(YT)})</script>`)).includes("youtube-embed");
  test("an unknown or custom type is data: a tag written as a JSON string in it is not detected", () => {
    for (const type of ["application/x-custom", "text/x-custom", "application/x-stripe-config", "text/jsx", "text/babel", "text/typescript", "application/octet-stream", "text/javascript1.6"]) {
      expect(hit(` type="${type}"`), type).toBe(false);
    }
    const stripe = `<script type="application/x-custom">{"loader":${json(STRIPE_TAG)}}</script>`;
    expect(ids(page(stripe))).not.toContain("stripe");
  });
  test("every JavaScript MIME type essence runs, in any case and with ASCII whitespace around it", () => {
    for (const type of [
      "text/javascript", "application/javascript", "application/ecmascript", "text/ecmascript", "text/jscript", "text/livescript",
      "text/x-javascript", "text/x-ecmascript", "application/x-javascript", "application/x-ecmascript",
      "text/javascript1.0", "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4", "text/javascript1.5",
      "TEXT/JavaScript", " \ttext/javascript\n ", "module", "MODULE",
    ]) {
      expect(hit(` type="${type}"`), JSON.stringify(type)).toBe(true);
    }
  });
  test("an empty type, no type, and a language alone run; a type beats a language", () => {
    expect(hit("")).toBe(true);
    expect(hit(' type=""')).toBe(true);
    expect(hit(' type="" language="foo"')).toBe(true);
    expect(hit(' language="javascript"')).toBe(true);
    expect(hit(' language="JavaScript1.3"')).toBe(true);
    expect(hit(' language=""')).toBe(true);
    expect(hit(' language="foo"')).toBe(false);
    expect(hit(' type="application/json" language="javascript"')).toBe(false);
    expect(hit(' type="text/javascript" language="foo"')).toBe(true);
  });
  test("a MIME parameter is not part of an essence: browsers do not run text/javascript;charset=utf-8, so it is data", () => {
    for (const type of ["text/javascript;charset=utf-8", "text/javascript; charset=utf-8", "application/javascript; charset=utf-8"]) {
      expect(hit(` type="${type}"`), type).toBe(false);
    }
  });
  test("a type with a character reference cannot be proved data, so it is read", () => {
    expect(hit(' type="text&#x2f;javascript"')).toBe(true);
  });
  test("the wrappers a cache, CDN or consent tool runs later stay read (#1435)", () => {
    for (const type of ["litespeed/javascript", "text/plain", "text/partytown", "0123456789abcdef0123456789abcdef-text/javascript"]) {
      expect(hit(` type="${type}"`), type).toBe(true);
    }
  });
  test("an import map keeps yielding script URLs while its text is cut (#1539)", () => {
    const map = '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script>';
    expect(ids(page(map))).toContain("threejs");
  });
});

describe("the end of a script needs a tag name boundary", () => {
  const data = (closer: string): string => `<script type="application/json">{"a":1}${closer}${YT}<script type="application/json">{}</script>`;
  test("</scriptx> does not end a data script: what follows it is still script text, not markup", () => {
    expect(ids(page(data("</scriptx>")))).not.toContain("youtube-embed");
  });
  test("</script followed by whitespace, a slash or > ends it, in any case", () => {
    for (const closer of ["</script>", "</script >", "</SCRIPT/>", "</script\n>", "</ScRiPt\t>", "</script/ x>"]) {
      expect(ids(page(`<script type="application/json">{"a":1}${closer}${YT}`)), JSON.stringify(closer)).toContain("youtube-embed");
    }
  });
  test("an inline JavaScript script is read to its real end tag too", () => {
    expect(ids(page(`<script>var a="</scriptx>";</script>${YT}`))).toContain("youtube-embed");
    expect(ids(page(`<script>var a=1;</script>${STRIPE_TAG}`))).toContain("stripe");
  });
  test("</script at the end of the page, with nothing after it, ends nothing", () => {
    expect(ids(page(`<script type="application/json">{"a":${json(YT)}}</script`))).toContain("youtube-embed");
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
  test("a self-closing template tag opens a template: HTML ignores the slash on a non-void element (Chrome 156 agrees)", () => {
    expect(ids(page(`<template/>${YT}</template>`))).not.toContain("youtube-embed");
    expect(ids(page(`<template />${STRIPE_TAG}</template>${YT}`))).toEqual(expect.arrayContaining(["youtube-embed"]));
    expect(ids(page(`<template />${STRIPE_TAG}</template>${YT}`))).not.toContain("stripe");
    // no end tag: nothing proves where it ends, so the text stays
    expect(ids(page(`<template/>${YT}`))).toContain("youtube-embed");
  });
  test("only a shadowrootmode of open or closed (ASCII case-insensitive, not trimmed, the first one) makes a template a shadow root", () => {
    const cutIn = (attrs: string): boolean => !ids(page(`<div><template${attrs}>${YT}</template></div>`)).includes("youtube-embed");
    for (const attrs of [' shadowrootmode="invalid"', " shadowrootmode", ' shadowrootmode=""', ' shadowrootmode=" open"', ' shadowroot="open"', ' shadowrootmode="x" shadowrootmode="open"']) {
      expect(cutIn(attrs), attrs).toBe(true);
    }
    for (const attrs of [' shadowrootmode="open"', ' shadowrootmode="CLOSED"', " shadowrootmode=open", ' shadowrootmode="open" shadowrootmode="x"']) {
      expect(cutIn(attrs), attrs).toBe(false);
    }
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
  test("only the marker detectors read comments, not the rest of their fingerprint (klaviyo, font-awesome)", () => {
    const loader = "<script>window._klOnsite=window._klOnsite||[];</script>";
    expect(ids(page(`<!-- ${loader} -->`))).not.toContain("klaviyo");
    expect(ids(page(`<!-- <script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script> -->`))).not.toContain("klaviyo");
    expect(ids(page(`<!-- <script src="https://kit.fontawesome.com/abc123.js"></script> -->`))).not.toContain("font-awesome");
    expect(ids(page(`<!-- <link rel="stylesheet" href="/css/fontawesome.min.css"> <i class="fa-solid fa-x"></i> -->`))).not.toContain("font-awesome");
    expect(ids(page(loader))).toContain("klaviyo");
    expect(ids(page(`<script src="https://kit.fontawesome.com/abc123.js"></script>`))).toContain("font-awesome");
    expect(ids(page("<!-- BEGIN app block: shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/00000000-0000-0000-0000-000000000000 -->"))).toContain("klaviyo");
    expect(ids(page("<!--!Font Awesome Free 6.5.1 by @fontawesome - https://fontawesome.com License-->"))).toContain("font-awesome");
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
  test("an unclosed template after a page-sized number of parts does not overflow the argument limit", () => {
    // The rollback compacts the markup parts in place: spreading ~300k parts into push() throws a RangeError.
    const map = '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"}}</script>';
    const many = '<script type="application/json">{}</script><!-- c -->'.repeat(150_000);
    expect(() => ids(page(`${many}<template>${map}`))).not.toThrow();
    expect(ids(page(`${many}<template>${map}`))).not.toContain("threejs");
  }, 60_000);
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
      "self-closing templates": "<template/>".repeat(100_000),
      "self-closing template pairs": "<template/></template>".repeat(50_000),
      "script closers without a boundary": '<script type="application/json">' + "</scriptx>".repeat(100_000),
      "unclosed data scripts": '<script type="application/x-custom">'.repeat(50_000),
      "custom type scripts": '<script type="application/x-custom">{}</script>'.repeat(50_000),
      "shadow roots": '<template shadowrootmode="open"></template>'.repeat(50_000),
      "padded types": `<script type="${" ".repeat(60_000)}text/javascript">x</script>`.repeat(20),
    };
    for (const [name, body] of Object.entries(shapes)) {
      const started = performance.now();
      ids(page(body));
      expect(performance.now() - started, name).toBeLessThan(4_000);
    }
  }, 60_000);
});
