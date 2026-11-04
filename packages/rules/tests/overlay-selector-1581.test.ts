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
];
/** Names a browser may accept (Chrome does not support the media-state ones): read as undecided, never as an error. */
const DOUBTFUL = [":nth-child(2n+1 of :bogus)", ":playing", ":muted", ":seeking", ":buffering", ":stalled", ":current(.a)", ":dir(foo)", ":nth-child(\\32 n)"];
/** Valid in Chrome (checked in headless Chrome 151). */
const VALID = [
  ":nth-child(2n + 1)",
  ":nth-child(-n+3)",
  ":nth-child(even)",
  ":nth-child(ODD)",
  ":nth-child(+n)",
  ":nth-child(n- 1)",
  ":nth-child(2n+1 of .a, .b)",
  ":nth-of-type(2n+1)",
  ":lang(en)",
  ":dir(ltr)",
  ":dir(RTL)",
  ":current",
  "::before::marker",
  "::part(x):hover",
  "::-webkit-scrollbar:horizontal",
  "::file-selector-button:hover",
  ".x::before",
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
});
