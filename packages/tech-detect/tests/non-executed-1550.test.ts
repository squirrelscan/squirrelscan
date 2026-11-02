// #1550: text a browser never runs or shows is not evidence: the body of a data script (JSON, JSON-LD, an import map), the inert
// content of a `<template>`, and an HTML comment, except the marker comments some fingerprints rely on on purpose. Built from
// parts, synthetic hosts and ids.

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { ALL_FINGERPRINTS, detectTechnologies } from "../src";
import { COMMENT_MARKER_FINGERPRINTS, pageViews } from "../src/inert-regions";

setDefaultTimeout(60_000);

const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const detects = (html: string, id: string): boolean => ids(html).includes(id);
const shell = (body: string, head = ""): string => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

const STRIPE = '<script src="https://js.stripe.com/v3/"></script>';
const YOUTUBE = '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>';

describe("the body of a data script is not evidence", () => {
  test("a vendor tag held as a string in JSON, JSON-LD, an import map or speculation rules", () => {
    for (const type of ["application/json", "application/ld+json", "importmap", "speculationrules", "text/x-handlebars-template", "text/template"]) {
      const html = shell(`<script type="${type}">{"x":${JSON.stringify(STRIPE)}}</script>`);
      expect(detects(html, "stripe"), type).toBe(false);
      expect(detects(shell(`<script type="${type}">["https://www.youtube.com/embed/abcdefghijk"]</script>`), "youtube-embed"), type).toBe(false);
    }
  });

  test("the type is read as the browser does: case, quotes and spaces", () => {
    for (const attr of ['type="APPLICATION/JSON"', "type='application/json'", "type=application/json", 'class="a"  type = "application/ld+json" ']) {
      expect(detects(shell(`<script ${attr}>${JSON.stringify(STRIPE)}</script>`), "stripe"), attr).toBe(false);
    }
  });

  test("a script that runs is read: no type, JavaScript, a module, and a type a cache or consent tool wraps a loader in", () => {
    for (const attr of ["", 'type="text/javascript"', 'type="module"', 'type="text/plain"', 'type="text/javascript-bla"', 'type="litespeed/javascript"', 'type="abc123-text/javascript"']) {
      const html = shell(`<script ${attr}>var u="https://www.youtube.com/embed/abcdefghijk";</script>`);
      expect(detects(html, "youtube-embed"), attr).toBe(true);
    }
  });

  test("a real tag next to a data script is still read, and the data script's own attributes are", () => {
    expect(detects(shell(`<script type="application/json">{}</script>${STRIPE}`), "stripe")).toBe(true);
  });

  test("a JSON string holding a closing script tag does not end the page early", () => {
    expect(detects(shell(`<script type="application/json">{"a":"</scr"}</script>${YOUTUBE}`), "youtube-embed")).toBe(true);
  });
});

describe("the content of a template is not evidence", () => {
  test("a script tag and an iframe inside a template", () => {
    expect(detects(shell(`<template>${STRIPE}</template>`), "stripe")).toBe(false);
    expect(detects(shell(`<template id="x">${YOUTUBE}</template>`), "youtube-embed")).toBe(false);
    expect(detects(shell(`<TEMPLATE>${STRIPE}</TEMPLATE>`), "stripe")).toBe(false);
  });

  test("a nested template is inert as a whole, and what follows its end is read", () => {
    expect(detects(shell(`<template><template>${STRIPE}</template>${YOUTUBE}</template>`), "youtube-embed")).toBe(false);
    const after = shell(`<template><template></template></template>${YOUTUBE}`);
    expect(detects(after, "youtube-embed")).toBe(true);
  });

  test("a declarative shadow root is rendered: its content is read", () => {
    expect(detects(shell(`<template shadowrootmode="open">${STRIPE}</template>`), "stripe")).toBe(true);
    expect(detects(shell(`<template shadowroot="open">${STRIPE}</template>`), "stripe")).toBe(true);
  });

  test("a template that never closes is not taken out: unclear stays detected", () => {
    expect(detects(shell(`<template>${STRIPE}`), "stripe")).toBe(true);
  });

  test("the word `template` in script text or an attribute does not open one", () => {
    expect(detects(shell(`<script>var t="<template>";</script>${YOUTUBE}`), "youtube-embed")).toBe(true);
    expect(detects(shell(`<div data-x="<template>">${YOUTUBE}</div>`), "youtube-embed")).toBe(true);
  });
});

describe("a commented-out tag is not evidence", () => {
  test("tags and loaders inside comments, on one line and over several", () => {
    expect(detects(shell(`<!-- ${STRIPE} -->`), "stripe")).toBe(false);
    expect(detects(shell(`<!--\n  ${YOUTUBE}\n  <p>x</p>\n-->`), "youtube-embed")).toBe(false);
    expect(detects(shell(`<!--[if IE]>${STRIPE}<![endif]-->`), "stripe")).toBe(false);
  });

  test("a downlevel-revealed conditional comment shows its content", () => {
    expect(detects(shell(`<!--[if !IE]><!-->${STRIPE}<!--<![endif]-->`), "stripe")).toBe(true);
  });

  test("a comment that never closes is not taken out: unclear stays detected", () => {
    expect(detects(shell(`<!-- ${STRIPE}`), "stripe")).toBe(true);
  });

  test("`<!--` in script, style, textarea or title text is not a comment", () => {
    expect(detects(shell(`<script>var s="<!--";</script>${YOUTUBE}`), "youtube-embed")).toBe(true);
    expect(detects(shell(`<style>/* <!-- */ .fa-solid{}</style>`), "font-awesome")).toBe(true);
    expect(detects(shell(`<textarea><!--</textarea>${YOUTUBE}`), "youtube-embed")).toBe(true);
    expect(detects(`<!doctype html><title><!--</title>${YOUTUBE}`, "youtube-embed")).toBe(true);
  });

  test("the comment before and after a real tag leaves the tag", () => {
    expect(detects(shell(`<!-- a -->${STRIPE}<!-- b -->`), "stripe")).toBe(true);
  });
});

describe("marker comments and CSS keep detecting", () => {
  const MARKERS: Array<[string, string]> = [
    ["wp-rocket", "<!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me -->"],
    ["litespeed-cache", "<!-- Page generated by LiteSpeed Cache 6.1 on 2026-01-01 00:00:00 -->"],
    ["w3-total-cache", "<!-- Performance optimized by W3 Total Cache. Learn more: https://www.boldgrid.com/w3-total-cache/ -->"],
    ["wp-super-cache", "<!-- Cached page generated by WP-Super-Cache on 2026-01-01 00:00:00 -->"],
    ["wp-fastest-cache", "<!-- WP Fastest Cache file was created in 0.2 seconds, on 01-01-26 @ 00:00 -->"],
    ["yoast-seo", "<!-- This site is optimized with the Yoast SEO plugin v22.0 - https://yoast.com/wordpress/plugins/seo/ -->"],
    ["rank-math", "<!-- Search Engine Optimization by Rank Math - https://rankmath.com/ -->"],
    ["all-in-one-seo", "<!-- All in One SEO Pro 4.5.0 - aioseo.com -->"],
    ["jekyll", "<!-- Begin Jekyll SEO tag v2.8.0 -->"],
    ["mailchimp", "<!-- Begin Mailchimp Signup Form -->"],
    ["klaviyo", "<!-- BEGIN app block: shopify://apps/klaviyo-email-marketing-sms/blocks/klaviyo-onsite-embed/00000000-0000-0000-0000-000000000000 -->"],
  ];
  for (const [id, comment] of MARKERS) {
    test(`${id}: its marker comment still detects`, () => {
      expect(detects(shell("<p>x</p>", comment), id)).toBe(true);
    });
  }

  test("a version still comes from the marker comment", () => {
    const found = detectTechnologies({ url: "https://example.com/", headers: {}, html: shell("", MARKERS[5]![1]) }).find((t) => t.id === "yoast-seo");
    expect(found?.version).toBe("22.0");
  });

  test("Font Awesome's banner inside an inline SVG, and its CSS, still detect", () => {
    expect(detects(shell(`<svg><!--!Font Awesome Free 6.5.1 by @fontawesome - https://fontawesome.com License--><path/></svg>`), "font-awesome")).toBe(true);
    expect(detects(shell(`<style>.fa-solid{font-weight:900}</style>`), "font-awesome")).toBe(true);
  });

  test("a marker comment does not make other fingerprints read commented-out code", () => {
    expect(detects(shell(`<!-- ${STRIPE} -->`, MARKERS[5]![1]), "stripe")).toBe(false);
  });

  test("the allowlist: every fingerprint with a pattern that opens at a comment is in it, and every id in it exists", () => {
    const known = new Set(ALL_FINGERPRINTS.map((fp) => fp.id));
    for (const id of COMMENT_MARKER_FINGERPRINTS) expect(known.has(id), id).toBe(true);
    for (const fp of ALL_FINGERPRINTS) {
      const opensAtComment = [...fp.detectors.map((d) => ("pattern" in d ? d.pattern.source : "")), fp.versionPattern?.source ?? ""].some((source) => /<!--|-->/.test(source));
      if (opensAtComment) expect(COMMENT_MARKER_FINGERPRINTS.has(fp.id), fp.id).toBe(true);
    }
  });
});

describe("real tags, loaders and tag readers are unchanged", () => {
  test("a real script tag, an inline loader and an iframe", () => {
    expect(detects(shell(STRIPE), "stripe")).toBe(true);
    expect(detects(shell(YOUTUBE), "youtube-embed")).toBe(true);
    expect(detects(shell(`<script>!function(){var s=document.createElement("script");s.src="https://js.stripe.com/v3/";}()</script>`), "stripe")).toBe(true);
  });

  test("the tag readers do not see a script inside a template", () => {
    expect(detects(shell(`<template><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script></template>`), "google-tag-manager")).toBe(false);
    expect(detects(shell(`<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>`), "google-tag-manager")).toBe(true);
  });
});

describe("pageViews", () => {
  test("a page with nothing to take out is the same string in every view", () => {
    const html = shell("<p>hello</p>");
    const v = pageViews(html);
    expect(v.markup).toBe(html);
    expect(v.clean).toBe(html);
    expect(v.commented).toBe(html);
  });

  test("what each view keeps", () => {
    const html = `<p>a</p><!--c--><template><b>t</b></template><script type="application/json">{"k":1}</script><script>var x=1;</script><style>.s{}</style>`;
    const v = pageViews(html);
    expect(v.markup).toBe(`<p>a</p><!--c--><script type="application/json">{"k":1}</script><script>var x=1;</script><style>.s{}</style>`);
    expect(v.clean).toBe(`<p>a</p><script type="application/json"></script><script>var x=1;</script><style>.s{}</style>`);
    expect(v.commented).toBe(`<p>a</p><!--c--><script type="application/json"></script><script>var x=1;</script><style>.s{}</style>`);
  });
});
