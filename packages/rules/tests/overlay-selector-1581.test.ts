// #1581: a decoy rule whose selector list holds a functional pseudo-class with an invalid argument, or a selector after a
// pseudo-element, is dropped whole by a browser, so it cannot hide a cover. Each input is tried at top level, in @media and nested.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";

import { isCover, overlayGeometryFor, selectorListState } from "../src/integrity/overlay-style";
import { detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://example.com/";
const FIXED = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";
const STATIC = "position:static";
const COVER = `.cover{${FIXED}}`;
const COVER_FRAME = '<iframe id="google-auth" class="cover" srcdoc=""></iframe>';

function parse(css: string) {
  const html = `<!doctype html><html><head><title>F</title><style>${css}</style></head><body><main><h1>F</h1>${COVER_FRAME}</main></body></html>`;
  return { html, parsed: parsePage(html, url) };
}
const fires = (css: string): boolean => {
  const { html, parsed } = parse(css);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectFakeAuthOverlay(ctx) !== null;
};
/** The tokens reading only: the other two split nested rules at their first `}`. */
const nestedCover = (css: string): boolean => {
  const doc = parse(css).parsed.document!;
  const el = doc.querySelector("iframe")!;
  return (["decided", "all"] as const).some((mode) => isCover(overlayGeometryFor(doc, el, "tokens", mode)));
};

/** Certain syntax errors in every engine. */
const INVALID = [
  ":nth-child(bogus)",
  ":nth-child()",
  ":nth-child(2n+)",
  ":nth-child(+ 5)",
  ":nth-last-child(foo)",
  ":nth-child(2n+1 of)",
  ":nth-child(of .a)",
  ":nth-child(2n+1 of !!)",
  ":nth-last-of-type(foo)",
  ":nth-of-type(2n of .a)",
  ":lang()",
  ":lang(en,)",
  ":lang(en fr)",
  ":lang(1)",
  ":nth-child(\u00a02n)",
  ":nth-child(2n\u00a0)",
  ":dir()",
  ":dir(1)",
  ":dir(ltr rtl)",
  "::before.x",
  "::before#x",
  "::before[a]",
  "::before:hover",
  "::after:focus",
  "::first-line:hover",
  ".x::before .y",
  ".x::before > .y",
  ".x:before .y",
  // two pseudo-elements, or an argument a pseudo-element does not take
  "::before:is(.a)::after",
  "::before:is(.a)::before",
  "::before:where(.a)::part(x)",
  "::first-line:is(.a)::after",
  "::placeholder:is(.a)::before",
  "::before::after",
  "::part(x)::part(y)",
  "::slotted(a)::first-line",
  ":not(::before)",
  ":not(:before)",
  "::part()",
  "::part(1)",
  "::slotted()",
  "::slotted(a, b)",
  "::before:not(.a)",
  // residuals: a highlight pseudo-element takes no further one, ::slotted() and :host() take one compound selector
  "::selection::before",
  "::highlight(x)::after",
  "::spelling-error::marker",
  "::slotted(a b)",
  "::slotted(a > b)",
  "::slotted(a + b)",
  ":host(::before)",
  ":host(.a::before)",
  ":host(a b)",
  ":host(a > b)",
  ":host-context(a b)",
];
/** Names a browser may accept (Chrome does not support the media-state ones): read as undecided, never as an error. */
const DOUBTFUL = ["::before:not(:is(.a))", "::after:not(:is(.a))", "::before:not(:where(.a))", "::marker:not(:is(.a))", "::before:not(:is(:hover))", ":nth-child(2n+1 of :bogus)", ":playing", ":muted", ":seeking", ":buffering", ":stalled", ":current(.a)", ":dir(foo)", ":nth-child(\\32 n)", ":nth-child(2n+1 Of .a)", ":host(a, b)", ":lang(en, fr)", ':lang("en")', ':lang("")', ":lang(*-Latn)", "::part(x):first-child", "::slotted(a):hover", "::selection:hover", "::highlight(x):hover", "::view-transition-old(root):hover", ":paused", ":volume-locked"];
/** Valid in Chrome (checked in headless Chrome 151). */
const VALID = [
  "::before::marker",
  "::after::marker",
  "::part(x)::before",
  "::part(x y)",
  "::part(x)::first-line",
  "::slotted(a)::before",
  "::slotted(a)::marker",
  ":nth-child(2n + 1)",
  ":nth-child(-n+3)",
  ":nth-child(even)",
  ":nth-child(ODD)",
  ":nth-child(+n)",
  ":nth-child(n- 1)",
  ":nth-child(2n+1 of .a, .b)",
  ":nth-of-type(2n+1)",
  ":lang(en)",
  ":lang(en-US)",
  ":lang(\\*-Latn)",
  ":nth-child(2n+1 of.a)",
  ":nth-child(2n+1 of#a)",
  ":nth-child(2n+1 of[a])",
  ":nth-child(2n+1 of:hover)",
  ":nth-child(2n+1 of*)",
  "::before:is(.a)",
  "::before:where(.a)",
  "::after:is(.a)",
  "::marker:where(.a)",
  "::placeholder:is(.a)",
  "::backdrop:where(.a)",
  "::first-line:is(.a)",
  "::first-letter:where(.a)",
  "::part(x):focus-visible",
  ":dir(ltr)",
  ":dir(RTL)",
  ":current",
  "::before::marker",
  "::part(x):hover",
  "::-webkit-scrollbar:horizontal",
  "::file-selector-button:hover",
  ".x::before",
  "::slotted(a.b:hover)",
  "::slotted(*)",
  ":host",
  ":host(.a)",
  ":host(.a:hover)",
  ":host-context(.a)",
  "::selection",
  "::selection:window-inactive",
];

describe("an invalid functional pseudo argument or a selector after a pseudo-element is a certain syntax error (#1581)", () => {
  test("the selector check reads each input", () => {
    for (const s of INVALID) expect(selectorListState(s, false), s).toBe("invalid");
    for (const s of INVALID) expect(selectorListState(`.a, ${s}`, false), `list ${s}`).toBe("invalid");
    for (const s of DOUBTFUL) expect(selectorListState(s, false), s).toBe("doubtful");
    for (const s of VALID) expect(selectorListState(s, false), s).toBe("valid");
  });

  for (const bad of INVALID) {
    test(`a decoy with ${bad} is dropped: the cover fires (top level, @media, nested)`, () => {
      expect(fires(`${COVER}.cover, ${bad}{${STATIC}}`)).toBe(true);
      expect(fires(`${COVER}@media screen{.cover, ${bad}{${STATIC}}}`)).toBe(true);
      expect(nestedCover(`.cover{${FIXED};&, ${bad}{${STATIC}}}`)).toBe(true);
    });
  }

  test("the same decoy with a valid pseudo-class still hides the cover (control)", () => {
    for (const ok of [":nth-child(2n+1)", ":lang(en)", ":dir(ltr)", "::before"]) {
      expect(fires(`${COVER}.cover, ${ok}{${STATIC}}`), ok).toBe(false);
    }
    expect(fires(`${COVER}@media screen{.cover, :nth-child(2n+1){${STATIC}}}`)).toBe(false);
    expect(nestedCover(`.cover{${FIXED};&, :nth-child(2n+1){${STATIC}}}`)).toBe(false);
  });

  test("a decoy with a valid ::selection, ::slotted() or :host() form still hides the cover (control, top level, @media, nested)", () => {
    for (const ok of ["::selection", "::slotted(a.b:hover)", ":host(.a)", ":host(.a:hover)"]) {
      expect(fires(`${COVER}.cover, ${ok}{${STATIC}}`), ok).toBe(false);
      expect(fires(`${COVER}@media screen{.cover, ${ok}{${STATIC}}}`), `@media ${ok}`).toBe(false);
      expect(nestedCover(`.cover{${FIXED};&, ${ok}{${STATIC}}}`), `nested ${ok}`).toBe(false);
    }
  });

  test("an input a browser may accept keeps the rule undecided: a decoy cannot hide the cover, a cover rule is not silent", () => {
    for (const s of DOUBTFUL) {
      expect(fires(`${COVER}.cover, ${s}{${STATIC}}`), s).toBe(true);
      expect(fires(`${COVER}@media screen{.cover, ${s}{${STATIC}}}`), `@media ${s}`).toBe(true);
      expect(fires(`.cover, ${s}{${FIXED}}`), `cover ${s}`).toBe(true);
    }
  });

  test("a cover rule using an invalid input is dropped too", () => {
    for (const bad of INVALID) {
      expect(fires(`.cover, ${bad}{${FIXED}}`), bad).toBe(false);
      expect(fires(`@media screen{.cover, ${bad}{${FIXED}}}`), `@media ${bad}`).toBe(false);
    }
  });

  test("a cover rule using a form Chrome accepts is never silent, and the valid ones hide a cover as decoys (top level, @media, nested)", () => {
    for (const sel of VALID.filter((v) => /of[.#[:*]|:is\(|:where\(|\\\*-Latn/.test(v))) {
      expect(fires(`.cover, ${sel}{${FIXED}}`), sel).toBe(true);
      expect(fires(`@media screen{.cover, ${sel}{${FIXED}}}`), `@media ${sel}`).toBe(true);
      expect(nestedCover(`main{${STATIC};${sel}{${FIXED}}}`) || nestedCover(`.cover{${STATIC};&, ${sel}{${FIXED}}}`), `nested ${sel}`).toBe(true);
    }
  });

  test("a decoy with a list, string or wildcard :lang() cannot hide a cover Chrome keeps", () => {
    for (const sel of [":lang(en, fr)", ':lang("en")', ":lang(*-Latn)", ':lang("")']) {
      expect(fires(`${COVER}.cover, ${sel}{${STATIC}}`), sel).toBe(true);
      expect(fires(`${COVER}@media screen{.cover, ${sel}{${STATIC}}}`), `@media ${sel}`).toBe(true);
      expect(nestedCover(`.cover{${FIXED};&, ${sel}{${STATIC}}}`), `nested ${sel}`).toBe(true);
    }
  });

  test(":is() and :where() after a pseudo-element are not an error, any other pseudo-class still is", () => {
    for (const el of ["before", "after", "marker", "placeholder", "backdrop", "first-line", "first-letter"]) {
      for (const f of ["is", "where"]) expect(selectorListState(`::${el}:${f}(.a)`, false), `${el} ${f}`).toBe("valid");
      expect(selectorListState(`::${el}:hover`, false), el).toBe("invalid");
    }
  });

  test("a pseudo-element inside the `of` list of :nth-child() is doubtful: a cover rule using it is never silent and a decoy using it cannot hide a cover", () => {
    const OF_LISTS = [":nth-child(2 of ::before)", ":nth-child(2n+1 of .a::before)", ":nth-child(2n+1 of .a, ::before)", ":nth-child(2 of :before)", ":nth-last-child(2 of ::part(x))", ":nth-child(2 of ::selection)", ":nth-child(2 of ::marker)"];
    for (const sel of OF_LISTS) {
      expect(fires(`.cover, ${sel}{${FIXED}}`), sel).toBe(true);
      // doubtful, not valid: a browser may reject a pseudo-element in an `of` list, so a decoy using it cannot hide the cover
      expect(fires(`${COVER}.cover, ${sel}{${STATIC}}`), `a decoy with ${sel} must not hide the cover`).toBe(true);
    }
  }, 30_000);

  test("a prelude of capital OF keywords is read in linear time", () => {
    const time = (n: number): number => {
      const started = performance.now();
      fires(`${COVER}.cover, :nth-child(2n${" OF".repeat(n)}){${STATIC}}`);
      return performance.now() - started;
    };
    time(2_000);
    const small = Math.max(time(20_000), 5);
    const large = time(80_000);
    expect(large, `80k took ${large.toFixed(0)} ms`).toBeLessThan(1_500);
    // linear is 4, quadratic is 16
    expect(large / small, `${small.toFixed(0)} ms to ${large.toFixed(0)} ms`).toBeLessThan(10);
  }, 60_000);
});
