// <noscript> content is inert text to a browser with scripting enabled (HTML
// Standard, "the noscript element"), so nothing in it loads, renders or reaches
// the accessibility tree (#434). Every rule below describes what a browser loads
// or renders, so each one must report a page whose snippet sits in <noscript>
// exactly as it reports the page without the snippet, and must still fire when
// the same snippet is live markup.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { parseHTML } from "@squirrelscan/parser/dom";
import {
  isInsideNoscript,
  querySelectorAllOutsideNoscript,
  stripNoscriptMarkup,
} from "@squirrelscan/utils";

import { frameTitleRule } from "../src/a11y/frame-title";
import { imageRedundantAltRule } from "../src/a11y/image-redundant-alt";
import { metaRefreshRule } from "../src/a11y/meta-refresh";
import { pageScriptSrcs } from "../src/adblock/blocked-links";
import { altTextRule } from "../src/images/alt-text";
import { aspectMismatchRule } from "../src/images/aspect-mismatch";
import { dimensionsRule } from "../src/images/dimensions";
import { filenameQualityRule } from "../src/images/filename-quality";
import { lazyLoadingRule } from "../src/images/lazy-loading";
import { modernFormatRule } from "../src/images/modern-format";
import { offscreenLazyRule } from "../src/images/offscreen-lazy";
import { optimizedRule } from "../src/images/optimized";
import { pictureElementRule } from "../src/images/picture-element";
import { responsiveSizeRule } from "../src/images/responsive-size";
import { srcsetRule } from "../src/images/srcset";
import { fingerprintPage } from "../src/integrity/fingerprint";
import { animatedContentRule } from "../src/performance/animated-content";
import { carouselHiddenEagerRule } from "../src/performance/carousel-hidden-eager";
import { clsHintsRule } from "../src/performance/cls-hints";
import { criticalRequestChainsRule } from "../src/performance/critical-request-chains";
import { duplicateJsRule } from "../src/performance/duplicate-js";
import { fontDeliveryRule } from "../src/performance/font-delivery";
import { fontLoadingRule } from "../src/performance/font-loading";
import { inpHintsRule } from "../src/performance/inp-hints";
import { jsLibrariesRule } from "../src/performance/js-libraries";
import { lazyAboveFoldRule } from "../src/performance/lazy-above-fold";
import { lcpFetchpriorityRule } from "../src/performance/lcp-fetchpriority";
import { lcpHintsRule } from "../src/performance/lcp-hints";
import { legacyJsRule } from "../src/performance/legacy-js";
import { preconnectRule } from "../src/performance/preconnect";
import { renderBlockingRule } from "../src/performance/render-blocking";
import { extractPageByteSignal } from "../src/performance/total-byte-weight";
import { unminifiedCssRule } from "../src/performance/unminified-css";
import { unminifiedJsRule } from "../src/performance/unminified-js";
import { mixedContentRule } from "../src/security/mixed-content";
import { sriRule } from "../src/security/sri";
import { thirdPartyCookiesRule } from "../src/security/third-party-cookies";
import type { Rule, RuleContext } from "../src/types";

const URL = "https://example.com/";

interface Snippet {
  head?: string;
  body?: string;
}

function page({ head = "", body = "" }: Snippet): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Noscript fixture page</title>${head}</head><body><main><h1>Noscript fixture</h1><p>Body copy for the fixture page.</p>${body}</main></body></html>`;
}

function ctx(html: string): RuleContext {
  return {
    page: { url: URL, html, statusCode: 200, loadTime: 0, headers: {} },
    parsed: parsePage(html, URL),
    site: { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null, scripts: [] },
    options: {},
  } as unknown as RuleContext;
}

function checksOf(rule: Rule, html: string) {
  const result = rule.run(ctx(html));
  if (result instanceof Promise) throw new Error(`${rule.meta.id} is async`);
  return result.checks;
}

function run(rule: Rule, html: string): string {
  return JSON.stringify(checksOf(rule, html));
}

/** The warn/fail/info checks, as comparable strings. */
function findings(rule: Rule, html: string): string[] {
  return checksOf(rule, html)
    .filter((c) => c.status === "warn" || c.status === "fail" || c.status === "info")
    .map((c) => JSON.stringify(c));
}

function wrap({ head, body }: Snippet): Snippet {
  return {
    head: head ? `<noscript>${head}</noscript>` : undefined,
    body: body ? `<noscript>${body}</noscript>` : undefined,
  };
}

const LONG_CSS = `.card { color: #333333; margin: 0 auto; padding: 16px 24px; }\n`.repeat(80);
const LONG_JS = `function add(first, second) {\n  return first + second;\n}\n`.repeat(80);
const GIF = `<img src="/spinner.gif" alt="Loading" width="40" height="40">`;
const HERO = `<img src="/IMG_1234.jpg">`;
const IMAGES = `<img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg"><img src="/d.jpg"><img src="/e.jpg"><img src="/f.jpg">`;

// One case per rule: a snippet that makes the rule fire as live markup.
const CASES: Array<[Rule, Snippet]> = [
  [frameTitleRule, { body: `<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X" height="0" width="0"></iframe>` }],
  [metaRefreshRule, { head: `<meta http-equiv="refresh" content="0; url=/no-js.html">` }],
  [imageRedundantAltRule, { body: `<img src="/logo.png" alt="Image of the company logo">` }],
  [altTextRule, { body: `<img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1">` }],
  [dimensionsRule, { body: HERO }],
  [responsiveSizeRule, { body: `<img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1">` }],
  [aspectMismatchRule, { body: `<img src="/hero.jpg" width="800" height="600" style="width: 400px; height: 400px">` }],
  [filenameQualityRule, { body: HERO }],
  [lazyLoadingRule, { body: IMAGES }],
  [modernFormatRule, { body: HERO }],
  [offscreenLazyRule, { body: IMAGES }],
  [optimizedRule, { body: HERO }],
  [pictureElementRule, { body: `<picture><source srcset="/hero.webp" type="image/webp"></picture>` }],
  [srcsetRule, { body: `<img src="/hero.jpg" width="1200" height="800">` }],
  [lcpHintsRule, { body: HERO }],
  [clsHintsRule, { body: HERO }],
  [lcpFetchpriorityRule, { body: `<img src="/hero.jpg" width="1200" height="800">` }],
  [lazyAboveFoldRule, { body: `<img src="/hero.jpg" width="1200" height="800" loading="lazy">` }],
  [carouselHiddenEagerRule, { body: `<div class="carousel"><div class="slide" hidden><img src="/slide-2.jpg"></div></div>` }],
  [animatedContentRule, { body: GIF }],
  [renderBlockingRule, { head: `<link rel="stylesheet" href="/theme.css"><script src="/app.js"></script>` }],
  [criticalRequestChainsRule, { head: `<link rel="stylesheet" href="/theme.css">` }],
  [preconnectRule, { head: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` }],
  [fontLoadingRule, { head: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` }],
  [fontDeliveryRule, { head: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` }],
  [inpHintsRule, { head: `<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>` }],
  [unminifiedCssRule, { head: `<style>${LONG_CSS}</style>` }],
  [unminifiedJsRule, { body: `<script>${LONG_JS}</script>` }],
  [duplicateJsRule, { body: `<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script><script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>` }],
  [jsLibrariesRule, { body: `<script src="https://code.jquery.com/jquery-1.12.4.min.js"></script>` }],
  // Under 50 characters, so the rule reads it through its raw-HTML marker scan.
  [jsLibrariesRule, { body: `<script>/* jQuery 1.12.0 */ jQuery.fn.jquery;</script>` }],
  [fontLoadingRule, { head: `<style>@font-face { font-family: Brand; src: url(/brand.woff2); }</style>` }],
  [legacyJsRule, { body: `<script src="https://polyfill.io/v3/polyfill.min.js"></script>` }],
  [sriRule, { body: `<script src="https://cdn.example.net/tracker.js"></script>` }],
  [thirdPartyCookiesRule, { body: `<img height="1" width="1" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1">` }],
  [mixedContentRule, { body: `<img src="http://cdn.example.net/pixel.gif" alt="">` }],
];

describe("rules ignore <noscript> content (#434)", () => {
  for (const [rule, snippet] of CASES) {
    describe(rule.meta.id, () => {
      const control = run(rule, page({}));

      test("the snippet inside <noscript> reports the same as no snippet at all", () => {
        expect(run(rule, page(wrap(snippet)))).toBe(control);
      });

      test("the same snippet as live markup is still reported", () => {
        const before = new Set(findings(rule, page({})));
        const added = findings(rule, page(snippet)).filter((f) => !before.has(f));
        expect(added.length).toBeGreaterThan(0);
      });
    });
  }

  test("a live <picture> whose only <img> is in <noscript> has no fallback", () => {
    const html = page({
      body: `<picture><source srcset="/hero.webp" type="image/webp"><noscript><img src="/hero.jpg" alt="Hero"></noscript></picture>`,
    });
    expect(pictureElementRule.run(ctx(html)).checks[0]?.status).toBe("fail");
  });

  test("a <noscript> WebM source does not give a live video a modern codec", () => {
    const live = page({ body: `<video controls><source src="/clip.mp4" type="video/mp4"></video>` });
    const withNoscript = page({
      body: `<video controls><source src="/clip.mp4" type="video/mp4"><noscript><source src="/clip.webm" type="video/webm"></noscript></video>`,
    });
    expect(run(animatedContentRule, withNoscript)).toBe(run(animatedContentRule, live));
  });

  test("live elements next to a <noscript> copy are still counted once", () => {
    const html = page({
      body: `<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-Y"></iframe></noscript>`,
    });
    const check = frameTitleRule.run(ctx(html)).checks[0];
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe("1 iframe(s) without title attribute");
  });
});

describe("noscript helpers", () => {
  test("stripNoscriptMarkup removes every <noscript> element, in any case, and nothing else", () => {
    expect(stripNoscriptMarkup(`a<noscript><img src="/x"></noscript>b<NOSCRIPT >c</NoScript >d`)).toBe("abd");
    expect(stripNoscriptMarkup(`<noscripts>kept</noscripts>`)).toBe(`<noscripts>kept</noscripts>`);
    expect(stripNoscriptMarkup(`before<noscript>unclosed`)).toBe("before");
    const plain = "<p>no fallback here</p>";
    expect(stripNoscriptMarkup(plain)).toBe(plain);
  });

  test.each([
    ["a JS string", `<script>const tag = "<noscript>";</script><style>@font-face{}</style>`],
    ["a CSS comment", `<style>/* <noscript> */ .a{}</style><p>live</p>`],
    ["an HTML comment", `<!-- <noscript> --><p>live</p>`],
    ["a quoted attribute", `<div title="<noscript>">live</div><p>live</p>`],
    ["a textarea", `<textarea><noscript></textarea><p>live</p>`],
  ])("stripNoscriptMarkup: a <noscript> inside %s is not a tag", (_name, html) => {
    expect(stripNoscriptMarkup(html)).toBe(html);
  });

  test.each([
    ["-->", `<!-- c -->`],
    ["--!>", `<!-- c --!>`],
    ["an abrupt <!-->", `<!-->`],
    ["an abrupt <!--->", `<!--->`],
  ])("stripNoscriptMarkup: a comment closed by %s does not hide the next <noscript>", (_name, comment) => {
    expect(stripNoscriptMarkup(`${comment}a<noscript>x</noscript>b`)).toBe(`${comment}ab`);
  });

  test("stripNoscriptMarkup: a quoted </noscript> in the start tag does not end it", () => {
    expect(stripNoscriptMarkup(`a<noscript data-x="</noscript>"><script>jQuery.fn.jquery</script></noscript>b`)).toBe("ab");
  });

  test("stripNoscriptMarkup: noscript content is raw text up to the first </noscript>", () => {
    expect(stripNoscriptMarkup(`a<noscript><script>"</noscript>"</script>b`)).toBe(`a"</script>b`);
  });

  const { document } = parseHTML(
    `<!DOCTYPE html><html><head><NOSCRIPT><link rel="stylesheet" href="/fallback.css"></NOSCRIPT><link rel="stylesheet" href="/live.css"></head><body><noscript><div><img src="/deep.png"></div></noscript><img src="/live.png"></body></html>`
  );

  test("querySelectorAllOutsideNoscript drops descendants of <noscript> at any depth, in any case", () => {
    const hrefs = querySelectorAllOutsideNoscript(document, "link").map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/live.css"]);
    const srcs = querySelectorAllOutsideNoscript(document, "img").map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["/live.png"]);
  });

  test("the <noscript> element itself is not inside one", () => {
    const noscripts = querySelectorAllOutsideNoscript(document, "noscript");
    expect(noscripts).toHaveLength(2);
    expect(noscripts.every((el) => !isInsideNoscript(el))).toBe(true);
  });

  test("a scoped root keeps its own matches only", () => {
    const head = document.querySelector("head");
    expect(head).not.toBeNull();
    if (!head) return;
    expect(querySelectorAllOutsideNoscript(head, "link")).toHaveLength(1);
  });
});

describe("shared page signals ignore <noscript> content", () => {
  const noscript = page({
    head: `<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>:root{--fallback-color:#000}</style></noscript>`,
    body: `<noscript><img src="https://www.facebook.com/tr?id=1"><script src="https://cdn.example.net/tracker.js"></script></noscript>`,
  });
  const control = page({});

  test("adblock/blocked-links: a <noscript> script is not one of the page's script srcs", () => {
    const doc = parsePage(noscript, URL).document;
    expect(doc).not.toBeNull();
    if (!doc) return;
    expect(pageScriptSrcs(doc)).toEqual([]);
  });

  test("total-byte-weight: <noscript> styles, scripts and images add no weight", () => {
    const withNoscript = parsePage(noscript, URL).document;
    const without = parsePage(control, URL).document;
    if (!withNoscript || !without) throw new Error("no document");
    expect(extractPageByteSignal(withNoscript)).toEqual(extractPageByteSignal(without));
  });

  test("the template key and a template-scoped verdict agree on a <noscript> @font-face", () => {
    // fingerprintPage drops <noscript> styles, so these two pages share a
    // template key; perf/font-loading must then give them the same verdict.
    const clean = page({});
    const fallback = page({
      head: `<noscript><style>:root{--fallback:1} @font-face{font-family:Fallback;src:url(/f.woff2)}</style></noscript>`,
    });
    expect(fingerprintPage(parsePage(fallback, URL), URL)).toEqual(
      fingerprintPage(parsePage(clean, URL), URL)
    );
    expect(run(fontLoadingRule, fallback)).toBe(run(fontLoadingRule, clean));
  });

  test("the template fingerprint is the asset graph the page loads", () => {
    const withNoscript = fingerprintPage(parsePage(noscript, URL), URL);
    const without = fingerprintPage(parsePage(control, URL), URL);
    expect(withNoscript).toEqual(without);

    const live = fingerprintPage(
      parsePage(page({ body: `<script src="https://cdn.example.net/tracker.js"></script>` }), URL),
      URL
    );
    expect([...(live?.assetHosts ?? [])]).toEqual(["cdn.example.net"]);
  });
});
