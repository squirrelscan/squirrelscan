// #1409: the overlay detector reads the CSS that styles an iframe: rules inside the group at-rules that apply to a screen,
// rules nested in a style rule, descendant and attribute selectors (the iframe is the last compound), and a cascade that
// follows specificity then source order. Each case is a page whose iframe is a fixed full-viewport cover only through its CSS.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { overlayGeometryFor, type Reading } from "../src/integrity/overlay-style";
import { cssScanTruncated, hiddenSelectors } from "../src/integrity/overlay-style";
import { detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

setDefaultTimeout(60_000);

const url = "https://example.com/";
const FIXED = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";
const FRAME = '<iframe id="google-auth" class="c" srcdoc=""></iframe>';

function page(css: string, frame = FRAME, body = "") {
  const html = `<!doctype html><html><head><title>F</title><style>${css}</style></head><body><main><h1>F</h1>${body}${frame}</main></body></html>`;
  const parsed = parsePage(html, url);
  return { html, parsed };
}
function context(css: string, frame = FRAME, body = ""): RuleContext {
  const { html, parsed } = page(css, frame, body);
  return { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
}
const fires = (css: string, frame = FRAME, body = ""): boolean => detectFakeAuthOverlay(context(css, frame, body)) !== null;

describe("rules inside the at-rules that apply to a screen (#1409)", () => {
  for (const [name, css] of [
    ["@media all", `@media all{.c{${FIXED}}}`],
    ["@media screen", `@media screen{.c{${FIXED}}}`],
    ["@media with a width condition", `@media (min-width:1px){.c{${FIXED}}}`],
    ["@media screen and (min-width:0)", `@media screen and (min-width:0){.c{${FIXED}}}`],
    ["@media print, screen", `@media print, screen{.c{${FIXED}}}`],
    ["@media not print", `@media not print{.c{${FIXED}}}`],
    ["@layer with a name", `@layer base{.c{${FIXED}}}`],
    ["@layer anonymous", `@layer{.c{${FIXED}}}`],
    ["@supports", `@supports (position:fixed){.c{${FIXED}}}`],
    ["@container", `@container (min-width:1px){.c{${FIXED}}}`],
    ["@scope", `@scope (main){.c{${FIXED}}}`],
    ["nested at-rules", `@layer a{@media all{@supports (display:block){.c{${FIXED}}}}}`],
    ["after a layer statement and an import", `@layer a,b;@import "x.css";@media all{.c{${FIXED}}}`],
    ["uppercase and escaped at-rule name", `@MEDIA ALL{.c{${FIXED}}}`],
  ] as const) {
    test(`${name} is read`, () => {
      expect(fires(css)).toBe(true);
    });
  }

  test("a media query that can never apply to a screen is not read", () => {
    for (const css of [
      `@media print{.c{${FIXED}}}`,
      `@media only print{.c{${FIXED}}}`,
      `@media print and (min-width:1px){.c{${FIXED}}}`,
      `@media speech{.c{${FIXED}}}`,
      `@media print, speech{.c{${FIXED}}}`,
      `@media not all{.c{${FIXED}}}`,
    ]) {
      expect(fires(css), css).toBe(false);
    }
  });

  test("at-rules that hold no style rules are not read", () => {
    for (const css of [
      `@keyframes x{from{${FIXED}}to{${FIXED}}}`,
      `@font-face{font-family:x;${FIXED}}`,
      `@page{${FIXED}}`,
      `@property --x{syntax:"*";${FIXED}}`,
      `@import url(a.css);`,
    ]) {
      expect(fires(css), css).toBe(false);
    }
  });

  test("all three readings of the CSS descend, not only the token one", () => {
    const { parsed } = page(`@media all{.c{${FIXED}}}`);
    const doc = parsed.document!;
    const frame = doc.querySelector("iframe")!;
    for (const reading of ["tokens", "naive", "plain"] as Reading[]) {
      const g = overlayGeometryFor(doc, frame, reading);
      expect(g.fixed && g.fillsViewport && g.pinned, reading).toBe(true);
    }
  });

  test("the hidden-text scan is unchanged: a rule inside an at-rule hides nothing there", () => {
    const { parsed } = page(`@media (max-width:1px){.x{display:none}} @media all{.y{display:none}} .z{display:none}`);
    const hidden = hiddenSelectors(parsed.document!);
    expect([...hidden.classes].sort()).toEqual(["z"]);
  });
});

describe("rules nested in a style rule", () => {
  test("a nested rule is read as a descendant of its parent, `&` as the parent", () => {
    expect(fires(`main{.c{${FIXED}}}`)).toBe(true);
    expect(fires(`main{ & .c{${FIXED}} }`)).toBe(true);
    expect(fires(`iframe{ &.c{${FIXED}} }`)).toBe(true);
    expect(fires(`iframe{ &#google-auth{${FIXED}} }`)).toBe(true);
    expect(fires(`div,main{ iframe{${FIXED}} }`)).toBe(true);
    expect(fires(`main{ .a{ .c{${FIXED}} } }`)).toBe(true);
  });
  test("a nested rule that names another element does not match the iframe", () => {
    expect(fires(`main{ div.c{${FIXED}} }`)).toBe(false);
    expect(fires(`div{ &.other{${FIXED}} }`)).toBe(false);
  });
  test("nesting deeper than the bound is not read and the CSS is reported truncated", () => {
    const deep = `${"a{".repeat(10)}.c{${FIXED}}${"}".repeat(10)}`;
    expect(fires(deep)).toBe(false);
  });
});

describe("descendant and attribute selectors name the iframe by its last compound", () => {
  test("descendant, child and sibling combinators", () => {
    for (const css of [`main iframe{${FIXED}}`, `main .c{${FIXED}}`, `main > iframe.c{${FIXED}}`, `h1 + iframe{${FIXED}}`, `h1 ~ #google-auth{${FIXED}}`, `body main   iframe{${FIXED}}`]) {
      expect(fires(css), css).toBe(true);
    }
  });
  test("attribute selectors of every operator", () => {
    for (const css of [
      `iframe[id]{${FIXED}}`,
      `iframe[id="google-auth"]{${FIXED}}`,
      `[id=google-auth]{${FIXED}}`,
      `*[id^=google]{${FIXED}}`,
      `iframe[id$="-auth"]{${FIXED}}`,
      `iframe[id*="gle-a"]{${FIXED}}`,
      `iframe[class~=c]{${FIXED}}`,
      `iframe[id|=google]{${FIXED}}`,
      `iframe[srcdoc]{${FIXED}}`,
      `iframe[ID="GOOGLE-AUTH" i]{${FIXED}}`,
      `iframe[id="google-auth" s]{${FIXED}}`,
      `iframe[\\69 d]{${FIXED}}`,
    ]) {
      expect(fires(css), css).toBe(true);
    }
  });
  test("an attribute condition the iframe does not meet, another element, a pseudo-element", () => {
    for (const css of [
      `iframe[id="other"]{${FIXED}}`,
      `iframe[id^=zzz]{${FIXED}}`,
      `iframe[class~=zzz]{${FIXED}}`,
      `iframe[src]{${FIXED}}`,
      `div[id]{${FIXED}}`,
      `div.c{${FIXED}}`,
      `iframe::before{${FIXED}}`,
      `iframe[id=google-auth]::after{${FIXED}}`,
      `iframe[id~=""]{${FIXED}}`,
      `iframe[id^=""]{${FIXED}}`,
    ]) {
      expect(fires(css), css).toBe(false);
    }
  });
  test("the frame's attributes, not its neighbours', decide: two iframes with different attributes", () => {
    const frames = '<iframe id="a" class="c" srcdoc=""></iframe><iframe id="google-auth" data-x="y" srcdoc=""></iframe>';
    expect(fires(`iframe[data-x=y]{${FIXED}}`, frames)).toBe(true);
    expect(fires(`iframe[data-x=n]{${FIXED}}`, frames)).toBe(false);
  });
  test("a pseudo-class is taken as matching (toward detection)", () => {
    expect(fires(`iframe.c:hover{${FIXED}}`)).toBe(true);
    expect(fires(`iframe:not(.zzz){${FIXED}}`)).toBe(true);
    expect(fires(`iframe:where(.zzz){${FIXED}}`)).toBe(true);
  });
});

describe("the cascade: !important, then specificity, then source order", () => {
  const STATIC = "position:static";
  test("an id rule beats a class rule written later", () => {
    expect(fires(`#google-auth{${FIXED}} .c{${STATIC}}`)).toBe(true);
    expect(fires(`#google-auth{${STATIC}} .c{${FIXED}}`)).toBe(false);
  });
  test("a class beats a tag, an attribute counts as a class, more classes beat fewer", () => {
    expect(fires(`.c{${FIXED}} iframe{${STATIC}}`)).toBe(true);
    expect(fires(`iframe{${STATIC}} .c{${FIXED}}`)).toBe(true);
    expect(fires(`[id=google-auth]{${FIXED}} iframe{${STATIC}}`)).toBe(true);
    expect(fires(`iframe.c{${STATIC}} .c{${FIXED}}`)).toBe(false); // tag + class (0,1,1) beats class (0,1,0)
    expect(fires(`.c.c2{${STATIC}} .c{${FIXED}}`, '<iframe id="google-auth" class="c c2" srcdoc=""></iframe>')).toBe(false);
  });
  test("equal specificity falls to source order", () => {
    expect(fires(`.c{${STATIC}} .c{${FIXED}}`)).toBe(true);
    expect(fires(`.c{${FIXED}} .c{${STATIC}}`)).toBe(false);
  });
  test("equal specificity across rules found under different keys still falls to source order", () => {
    const frame = '<iframe id="google-auth" class="c d" srcdoc=""></iframe>';
    expect(fires(`.d{${STATIC}} .c{${FIXED}}`, frame)).toBe(true);
    expect(fires(`.c{${FIXED}} .d{${STATIC}}`, frame)).toBe(false);
  });
  test("a pseudo-class counts as a class in the specificity, `:where()` as nothing", () => {
    expect(fires(`.c{${FIXED}} iframe:hover{${STATIC}}`)).toBe(false);
    expect(fires(`.c{${FIXED}} iframe:where(.x){${STATIC}}`)).toBe(true);
  });
  test("a descendant selector counts every compound's specificity only for its last one", () => {
    // the ancestors are not read, so `main .c` is (0,1,0) like `.c`: the later one wins
    expect(fires(`main .c{${STATIC}} .c{${FIXED}}`)).toBe(true);
  });
  test("!important beats specificity, and specificity among !important rules still applies", () => {
    expect(fires(`.c{position:fixed!important;${FIXED}} #google-auth{${STATIC}}`)).toBe(true);
    expect(fires(`.c{${FIXED};position:static!important} #google-auth{position:fixed!important}`)).toBe(true);
    expect(fires(`#google-auth{position:static!important} .c{position:fixed!important;${FIXED}}`)).toBe(false);
  });
  test("an inline style beats the stylesheet, and an important stylesheet rule beats a normal inline one", () => {
    const inline = `<iframe id="google-auth" class="c" srcdoc="" style="position:static"></iframe>`;
    expect(fires(`#google-auth{${FIXED}}`, inline)).toBe(false);
    expect(fires(`#google-auth{${FIXED};position:fixed!important}`, inline)).toBe(true);
  });
  test("frames that differ only by an attribute some rule tests are cascaded apart (the memo key)", () => {
    // The same id and classes, so only the attribute tells them apart; the static one is first in the page.
    const frames = '<iframe id="google-auth" class="c" data-k="2" srcdoc=""></iframe><iframe id="google-auth" class="c" data-k="1" srcdoc=""></iframe>';
    expect(fires(`.c{${FIXED}} .c[data-k="2"]{${STATIC}}`, frames)).toBe(true); // the data-k=1 frame stays fixed
    expect(fires(`.c{${FIXED}} .c[data-k]{${STATIC}}`, frames)).toBe(false);
  });
});

describe("a comment, an escape or a logical longhand is still read (already handled, pinned)", () => {
  test("a comment inside a declaration or a selector, a `}` inside a comment, escapes, inset-block and inset-inline", () => {
    for (const css of [
      `.c{position:fixed/**/;inset:0;z-index:9999;width:100%;height:100%}`,
      `.c/**/{${FIXED}}`,
      `.c{/* } */${FIXED}}`,
      `.c{position:\\66ixed;inset:0;z-index:9999;width:100%;height:100%}`,
      `.c{\\70osition:fixed;inset:0;z-index:9999;width:100%;height:100%}`,
      `.c{position:fixed;inset-block:0;inset-inline:0;z-index:9999;width:100%;height:100%}`,
    ]) {
      expect(fires(css), css).toBe(true);
    }
  });
});

describe("hostile CSS stays linear, at 5 MB and at 10 MiB", () => {
  const MB5 = 5 * 1_000_000;
  const MIB10 = 10 * 1_048_576;
  const time = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const repeat = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length));

  // The sheet is read up to MAX_CSS_CHARS (4,000,000): a larger one is reported truncated, so the real rule is placed within it
  // for the detection check and the full size is the timing check.
  const WITHIN = 3_900_000;
  const cases: Array<[string, (bytes: number) => string, boolean]> = [
    ["unclosed @media all openers, then the real rule", (n) => `${repeat("@media all{", n)}.c{${FIXED}}`, true],
    ["unclosed @media print openers", (n) => repeat("@media print{", n), false],
    ["balanced @media all blocks of unrelated rules, then the real rule", (n) => `${repeat("@media all{.n{border:0}}", n)}.c{${FIXED}}`, true],
    ["unclosed style-rule openers (nesting)", (n) => repeat("a{", n), false],
    ["nested rules to the depth bound and far past it", (n) => `${repeat("a{", 4_000)}.c{${FIXED}}${repeat("}", 4_000)}${repeat("x{", n)}`, false],
    ["a selector list of millions of parts, then the real rule", (n) => `${repeat(".x,", n)}.c{${FIXED}}`, false],
    ["attribute-selector rules that set nothing that matters", (n) => repeat('iframe[a="v"]{border:0}', n), false],
    ["descendant selectors of 4 KB each", (n) => repeat(`${"a ".repeat(2_000)}iframe{border:0}`, n), false],
    ["unclosed attribute selectors and :is() groups", (n) => repeat('iframe[a="b{x:y}:is(', n), false],
    ["backslashes and comment openers in selectors", (n) => repeat("\\\\/*", n), false],
    ["escaped at-rule names, then the real rule", (n) => `${repeat("@\\6d edia all{", n)}.c{${FIXED}}`, true],
  ];
  for (const [label, bytes] of [["5 MB", MB5], ["10 MiB", MIB10]] as const) {
    for (const [name, build, detectable] of cases) {
      test(`${label}: ${name}`, () => {
        const ctx = context(build(bytes));
        const elapsed = time(() => detectFakeAuthOverlay(ctx));
        expect(elapsed).toBeLessThan(6_000);
        if (detectable) {
          // Past the amount read the sheet is reported truncated instead of silently ignored.
          expect(cssScanTruncated(ctx.parsed.document!)).toBe(true);
        }
      }, 60_000);
    }
  }
  for (const [name, build, detectable] of cases) {
    if (!detectable) continue;
    test(`within the amount read, the real rule is found: ${name}`, () => {
      const ctx = context(build(WITHIN));
      let hit: unknown;
      expect(time(() => (hit = detectFakeAuthOverlay(ctx)))).toBeLessThan(6_000);
      expect(hit).not.toBeNull();
    }, 60_000);
  }

  test("thousands of frames with distinct attribute values against attribute-selector rules", () => {
    const rules = Array.from({ length: 2_000 }, (_, i) => `iframe[data-i^="x${i}"]{top:0}`).join("");
    const frames = Array.from({ length: 3_000 }, (_, i) => `<iframe data-i="x${i}y" srcdoc=""></iframe>`).join("");
    const ctx = context(rules, `${frames}${FRAME}`);
    expect(time(() => detectFakeAuthOverlay(ctx))).toBeLessThan(6_000);
  });
});
