// #1409: the overlay detector reads the CSS that styles an iframe: rules inside the group at-rules that apply to a screen,
// rules nested in a style rule, descendant and attribute selectors (the iframe is the last compound), and a cascade that
// follows specificity then source order. Each case is a page whose iframe is a fixed full-viewport cover only through its CSS.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { overlayGeometryFor, type Reading } from "../src/integrity/overlay-style";
import { cssScanTruncated, hiddenSelectors, isCover, nestingUsed } from "../src/integrity/overlay-style";
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

describe("a rule whose applicability cannot be decided never disables a cover (#1409 review)", () => {
  const STATIC = "position:static";
  const COVER = `.c{${FIXED}}`;
  test("a decoy that a browser would not apply, written after the cover, does not hide it", () => {
    for (const decoy of [
      `@media (max-width:1px){.c{${STATIC}}}`,
      `@media (min-width:5000px){.c{${STATIC}}}`,
      `@media not (display:grid){.c{${STATIC}}}`,
      `@supports (display:foo){.c{z-index:1}}`,
      `@supports not (position:fixed){.c{${STATIC}}}`,
      `@scope (.nothing){.c{width:1px}}`,
      `@container (min-width:99999px){.c{${STATIC}}}`,
      `@layer a{.c{${STATIC}}}`, // a layered rule loses to the unlayered cover in a browser
      `.nothing .c{${STATIC}}`,
      `main > .c{${STATIC}}`,
      `html.x iframe.c{z-index:1}`,
      `.c:hover{${STATIC}}`,
      `.c:not(.c){${STATIC}}`,
      `.c:focus-within{width:1px}`,
      `iframe:target{${STATIC}}`,
      `#google-auth:not(.c){${STATIC}}`,
      `@media (max-width:1px){#google-auth{${STATIC}}}`, // a higher specificity does not help it
      `@media (max-width:1px){.c{${STATIC}!important}}`, // nor an !important one
    ]) {
      expect(fires(`${COVER}${decoy}`), decoy).toBe(true);
    }
  });
  test("a nested rule inside a parent that need not match, and a parent with an ancestor part, is undecided too", () => {
    expect(fires(`${COVER} .nothing{ .c{${STATIC}} }`)).toBe(true); // `.nothing .c`: an ancestor that is not evaluated
    expect(fires(`${COVER} .nothing .c{ &{${STATIC}} }`)).toBe(true); // `&` is the parent's last compound, its ancestor dropped
    expect(fires(`${COVER} .nothing{ & > .c{${STATIC}} }`)).toBe(true);
    expect(fires(`${COVER} .c:hover{ &{${STATIC}} }`)).toBe(true);
    expect(fires(`${COVER} .c{ &{${STATIC}} }`)).toBe(false); // an exact nested rule is decided
  });
  test("the same decoys written before the cover, and nested", () => {
    expect(fires(`@media (max-width:1px){.c{${STATIC}}}${COVER}`)).toBe(true);
    expect(fires(`.c{${FIXED}} main{ .c:hover{${STATIC}} }`)).toBe(true);
    expect(fires(`.c{${FIXED}} @media (max-width:1px){ .c{ ${STATIC} } }`)).toBe(true);
  });
  test("a decoy that is decided (a screen, an exact selector) still disables it, as in a browser", () => {
    expect(fires(`${COVER}@media screen{.c{${STATIC}}}`)).toBe(false);
    expect(fires(`${COVER}@media all{.c{${STATIC}}}`)).toBe(false);
    expect(fires(`${COVER}.c{${STATIC}}`)).toBe(false);
    expect(fires(`${COVER}#google-auth{${STATIC}}`)).toBe(false);
  });
  test("a rule that cannot be evaluated can still enable a cover (a lone signal, as for any undecided rule)", () => {
    for (const css of [
      `.c:hover{${FIXED}}`,
      `.modal-open .c{${FIXED}}`,
      `body.noscroll iframe{${FIXED}}`,
      `[data-state=closed] .c{${FIXED}}`,
      `@media (min-width:5000px){.c{${FIXED}}}`,
      `@supports (display:foo){.c{${FIXED}}}`,
      `@layer a{.c{${FIXED}}}`,
      `@container (min-width:1px){.c{${FIXED}}}`,
    ]) {
      expect(fires(css), css).toBe(true);
    }
  });
  test("an undecided rule enabling the cover does not beat a decided rule that disables it", () => {
    // the decided cascade alone has no cover, and the full one has the undecided rule applied: reported (either)
    expect(fires(`.c{${STATIC}} @media (min-width:1px){.c{${FIXED}}}`)).toBe(true);
    // with nothing undecided there is one cascade and it is the browser's
    expect(fires(`.c{${FIXED}} .c{${STATIC}}`)).toBe(false);
  });
  test("a prelude past 2,048 characters is read as undecided, never skipped: its block is still read", () => {
    for (const length of [2_060, 3_000, 100_000]) {
      const prelude = `screen, ${"(min-width:1px),".repeat(Math.ceil(length / 16))} (x)`;
      expect(fires(`@media ${prelude}{.c{${FIXED}}}`), `${length}`).toBe(true);
      expect(fires(`${COVER}@media ${prelude}{.c{${STATIC}}}`), `${length} decoy`).toBe(true);
    }
  });
  test("the three readings all apply the decided cascade", () => {
    const { parsed } = page(`${COVER}@media (max-width:1px){.c{${STATIC}}}`);
    const doc = parsed.document!;
    const frame = doc.querySelector("iframe")!;
    for (const reading of ["tokens", "naive", "plain"] as Reading[]) {
      const g = overlayGeometryFor(doc, frame, reading, "decided");
      expect(g.fixed && g.fillsViewport && g.pinned, reading).toBe(true);
      const all = overlayGeometryFor(doc, frame, reading, "all");
      expect(all.fixed, `${reading} all`).toBe(false); // the full cascade applies the decoy
    }
  });
});

describe("an open rule ends at the end of the text, and the order of a nested rule is a browser's (#1409 review)", () => {
  // The cascade of the token reading alone (the plain reading does not see nesting, and a cover in any reading is reported).
  const tokenCover = (css: string): boolean => {
    const doc = page(css).parsed.document!;
    const frame = doc.querySelector("iframe")!;
    return isCover(overlayGeometryFor(doc, frame, "tokens"));
  };
  test("an unclosed rule, also inside an unclosed at-rule", () => {
    for (const reading of ["tokens", "naive", "plain"] as Reading[]) {
      const doc = page(`.c{${FIXED}`).parsed.document!;
      expect(isCover(overlayGeometryFor(doc, doc.querySelector("iframe")!, reading)), reading).toBe(true);
    }
    expect(tokenCover(`@media all{.c{${FIXED}`)).toBe(true);
    expect(tokenCover(`main{ .c{${FIXED}`)).toBe(true);
    expect(fires(`.c{${FIXED}`)).toBe(true);
    expect(fires(`@media all{.c{${FIXED}`)).toBe(true);
    expect(fires(`@media all{.n{border:0} .c{${FIXED}`)).toBe(true);
    expect(fires(`main{ .c{${FIXED}`)).toBe(true);
  });
  test("an unclosed rule that is not a cover is not one", () => {
    expect(fires(`.c{position:static;z-index:1`)).toBe(false);
  });
  test("a nested rule comes after the declarations before it and before those after it", () => {
    expect(tokenCover(`.c{ position:static; &{${FIXED}} }`)).toBe(true); // the nested rule is later than its parent's declarations
    expect(tokenCover(`.c{ &{position:static} ${FIXED} }`)).toBe(true); // declarations after a nested rule come last
    expect(tokenCover(`.c{ ${FIXED}; &{position:static} }`)).toBe(false); // the nested rule is last
    expect(tokenCover(`.c{ ${FIXED}; &{border:0} z-index:1 }`)).toBe(false); // z-index:1 comes last
    expect(tokenCover(`.c{ ${FIXED}; &{border:0} z-index:5000 }`)).toBe(true);
  });
  test("a nested block without `;` before the next declaration does not garble it", () => {
    expect(fires(`.c{ &{border:0} position:fixed;inset:0;z-index:9999;width:100%;height:100% }`)).toBe(true);
    // (`height:100% &{...}` is a nested rule with an invalid selector in a browser: the declaration is not one)
    expect(tokenCover(`.c{ position:fixed;inset:0;z-index:9999;width:100%;height:100% &{border:0} }`)).toBe(false);
    expect(fires(`.c{ position:fixed;inset:0;&{border:0} z-index:9999;width:100%;height:100% }`)).toBe(true);
  });
  test("`&` is the parent's last compound, in a compound or alone", () => {
    const withP = '<iframe id="google-auth" class="p c" srcdoc=""></iframe>';
    expect(fires(`.p{ &.c{${FIXED}} }`, withP)).toBe(true);
    expect(fires(`.p{ &.c{${FIXED}} }`)).toBe(false); // the frame has no `p`
    expect(fires(`.p{ .c&{${FIXED}} }`, withP)).toBe(true);
    expect(fires(`.p{ &{${FIXED}} }`, withP)).toBe(true);
    expect(fires(`.p{ &{${FIXED}} }`)).toBe(false);
    expect(fires(`iframe{ &#google-auth{${FIXED}} }`)).toBe(true);
    expect(fires(`main .p{ &.c{${FIXED}} }`, withP)).toBe(true); // the parent's ancestor is not evaluated
  });
  test("an attribute value is compared without case on both sides", () => {
    expect(fires(`iframe[data-k=Vv]{${FIXED}}`, '<iframe id="google-auth" data-k="Vv" srcdoc=""></iframe>')).toBe(true);
    expect(fires(`iframe[data-k=vv]{${FIXED}}`, '<iframe id="google-auth" data-k="VV" srcdoc=""></iframe>')).toBe(true);
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

describe("CSS nesting is bounded: no product of selectors, lengths or rules (#1409 review)", () => {
  const time = (run: () => unknown): number => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const probe = (css: string) => {
    const { parsed } = page(css);
    const doc = parsed.document!;
    let elapsed = 0;
    const ctx = context(css);
    elapsed = time(() => detectFakeAuthOverlay(ctx));
    return { elapsed, used: nestingUsed(ctx.parsed.document!), truncated: cssScanTruncated(ctx.parsed.document!), doc };
  };
  const parts = (prefix: string, n: number, withAmp = true): string =>
    Array.from({ length: n }, (_, i) => `${withAmp ? "&" : ""}${prefix}${i}`).join(",");

  test("20 comma-separated parts per level, 10 levels deep, every part using `&`: bounded counts, truncated", () => {
    let css = `.c{${FIXED}}`;
    for (let level = 10; level >= 1; level--) css = `${parts(`.k${level}_`, 20)}{${css}}`;
    const r = probe(css);
    expect(r.used.selectors).toBeLessThanOrEqual(20_000);
    expect(r.used.rules).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true); // ten levels is past the depth bound of eight
    expect(r.elapsed).toBeLessThan(3_000);
  });

  test("parents times children is capped at 64 parts each", () => {
    // 200 parts against 200 `&` parts would be 40,000 selectors; at most 64 x 64 are produced, and the cut is reported
    const css = `${parts(".p", 200, false)}{ ${parts(".q", 200)}{${FIXED}} }`;
    const r = probe(css);
    expect(r.used.selectors).toBeLessThanOrEqual(64 * 64);
    expect(r.truncated).toBe(true);
  });

  test("the budget of produced selectors is shared by the whole sheet and reported when spent", () => {
    // each rule produces 64 x 64 = 4,096 selectors: the 20,000 are spent in the fifth rule
    const rule = `${parts(".p", 64, false)}{ ${parts(".q", 64)}{border:0} }`;
    const r = probe(rule.repeat(40));
    expect(r.used.selectors).toBe(20_000);
    expect(r.truncated).toBe(true);
  });

  test("a child without `&` is produced once, however many parents there are", () => {
    const r = probe(`${parts(".p", 64, false)}{ .x{border:0} .y{border:0} }`);
    expect(r.used.selectors).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test("a run of `&` is not expanded: one part of 1 MB of `&`, and 1,000 `&` against a long parent", () => {
    const huge = probe(`a{ ${"&".repeat(1_000_000)}{${FIXED}} }`);
    expect(huge.used.selectors).toBe(0);
    expect(huge.truncated).toBe(true);
    expect(huge.elapsed).toBeLessThan(3_000);
    const parent = `.${"p".repeat(2_000)}`;
    const long = probe(`${parent}{ ${"&".repeat(1_000)}{${FIXED}} }`);
    expect(long.used.selectors).toBe(0); // 1,000 x 2,000 characters would be 2 MB: dropped before it is built
    expect(long.truncated).toBe(true);
  });

  test("a produced selector never grows from level to level", () => {
    // `&&` doubles the parent's last compound at each level; the bound stops it long before 2^8 x 1,000
    let css = `.c{${FIXED}}`;
    for (let level = 8; level >= 1; level--) css = `${level === 1 ? `.${"z".repeat(1_000)}` : "&&"}{${css}}`;
    const r = probe(css);
    expect(r.elapsed).toBeLessThan(3_000);
    expect(r.used.selectors).toBeLessThanOrEqual(8);
    expect(r.truncated).toBe(true); // the doubling reaches the length bound and is reported
  });

  test("50,000 levels of nesting are scanned iteratively and reported truncated", () => {
    const r = probe(`${"a{".repeat(50_000)}.c{${FIXED}}${"}".repeat(50_000)}`);
    expect(r.truncated).toBe(true);
    expect(r.used.rules).toBeLessThanOrEqual(8);
    expect(r.elapsed).toBeLessThan(6_000);
  });

  test("nested rules are counted against a per-sheet cap and reported when it is reached", () => {
    // two parents of 60,000 nested rules each (240 KB, under the body bound): 120,000 rules, 50,000 are read
    const r = probe(`a{${".x{}".repeat(60_000)}} b{${".x{}".repeat(60_000)}}`);
    expect(r.used.rules).toBe(50_000);
    expect(r.truncated).toBe(true);
    expect(r.elapsed).toBeLessThan(6_000);
  });

  test("the rule cap holds on its own: nested rules that produce no selector are counted too", () => {
    const r = probe(`a{${">{}".repeat(80_000)}}`); // 240 KB of nested rules with no compound to read
    expect(r.used).toEqual({ rules: 50_000, selectors: 0 });
    expect(r.truncated).toBe(true);
  });

  test("a style rule whose body is past the bound and holds nested rules is reported, not skipped in silence", () => {
    const padded = `main{${"/*pad*/".repeat(60_000)} .c{${FIXED}} }`; // 360 KB body with a nested iframe rule
    expect(padded.length).toBeGreaterThan(262_144);
    const r = probe(padded);
    expect(r.truncated).toBe(true);
    // a large body with no nested rule is skipped without a signal, as before (it cannot match an iframe)
    expect(probe(`main{${"/*pad*/".repeat(60_000)}color:red}`).truncated).toBe(false);
  });

  test("a nested rule whose own selector or body is past the bounds is reported", () => {
    const longSelector = `.${"s".repeat(300_000)}`;
    expect(probe(`main{ ${longSelector}{${FIXED}} }`).truncated).toBe(true);
    expect(probe(`main{ .c{${"/*pad*/".repeat(60_000)}${FIXED}} }`).truncated).toBe(true);
  });

  test("a page with no nested rule spends none of the budget and is not reported truncated", () => {
    const r = probe(`.c{${FIXED}} @media all{.d{border:0}}`);
    expect(r.used).toEqual({ rules: 0, selectors: 0 });
    expect(r.truncated).toBe(false);
  });
});
