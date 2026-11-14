// #1557, #1569: the cut of an oversized class attribute must come from the tokenizer's own reading of the page. Each case is a page
// crafted so that a second, hand-written reading of the markup would disagree with htmlparser2 (comments, bogus comments, CDATA,
// raw-text elements, quoting, entities, duplicate attributes, case, `<` inside values, unfinished tags). The oracle is linkedom itself:
// the page parses (with a small limit nothing overflows), and the page the cut produces must parse to the SAME tree, with only the
// class of the elements the tokenizer reads cut to its first LIMIT tokens, and with exactly those cuts reported. Nothing here
// states what the markup means; the parse does. Fixtures are built from parts.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "../src/dom";
import * as current from "../src/dom";

const LIMIT = 5;
// A variable specifier: the scratch copy is not committed, so a literal path would fail typechecking.
const OLD_IMPL_PATH = "./_old-dom-1558";
// `TRUNC_IMPL=old` runs the same table against the first cut (#1558), kept as a scratch copy to show the cases fail there.
const impl: { truncateClassAttributes: (html: string, limit: number) => { text: string; cut: number[] } } = process.env.TRUNC_IMPL === "old" ? await import(OLD_IMPL_PATH) : current;

const T = (n: number, sep = " ", prefix = "c"): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(sep);
const N = T(12);
const AFTER = `<p id="after">tail</p>`;

interface Dumped {
  lines: string[];
  overLimit: number[];
}

/** The tree as linkedom reads it: element, id, class tokens (cut to `limit` when asked), text and comments, in document order. */
function dump(html: string, limit: number | null): Dumped {
  const { document } = parseHTML(html);
  const lines: string[] = [];
  const overLimit: number[] = [];
  const walk = (node: any): void => {
    for (const child of Array.from(node.childNodes as ArrayLike<any>)) {
      if (child.nodeType === 1) {
        // linkedom feeds only an attribute spelt exactly `class` to its class setter (a `CLASS` is not cut, and cannot overflow)
        const reads = Array.from(child.attributes as ArrayLike<{ name: string }>).some((attribute) => attribute.name === "class");
        let tokens: string[] = reads ? Array.from(child.classList as Iterable<string>) : [];
        // distinct tokens only: a repeated token would collapse in the class list and hide a cut
        if (limit !== null && tokens.length > limit) {
          overLimit.push(tokens.length);
          tokens = tokens.slice(0, limit);
        }
        lines.push(`<${child.localName} id=${child.getAttribute("id")} class=${JSON.stringify(tokens)}>`);
        walk(child);
      } else lines.push(`#${child.nodeType}:${JSON.stringify(child.textContent)}`);
    }
  };
  walk(document);
  return { lines, overLimit };
}

function expectSameTreeCutOnlyClass(html: string): void {
  const expected = dump(html, LIMIT);
  const { text, cut } = impl.truncateClassAttributes(html, LIMIT);
  expect(cut).toEqual(expected.overLimit);
  expect(dump(text, null).lines).toEqual(expected.lines);
  if (expected.overLimit.length === 0) expect(text).toBe(html);
}

const CASES: Array<[string, string]> = [
  // a fake tag inside a construct the tokenizer reads as one bogus comment, whose quoted value spans real markup
  ["processing instruction opener hides a fake class whose value spans a real element", `<?x <b class="${N} > <img id=victim> ">${AFTER}`],
  ["bogus comment <!x hides a fake class", `<!x <b class='${N} > <img id=victim> '>${AFTER}`],
  ["CDATA opener hides a fake class", `<![CDATA[ <b class="${N} > <img id=victim> "> ]]>${AFTER}`],
  ["<!< opener hides a fake class", `<!<d class='${N} > <img id=victim> '>${AFTER}`],
  ["</< closer hides a fake class", `</<p class='${N} > <img id=victim> '>${AFTER}`],
  // abrupt comments end at the first `>`: what follows is markup, and a raw-text element after it is raw text
  ["abrupt comment <!--> then an oversized class", `<!--><p id=a class="${N}">x</p>${AFTER}`],
  ["abrupt comment <!---> then an oversized class", `<!---><p id=a class="${N}">x</p>${AFTER}`],
  ["title after an abrupt comment holds text, not a tag", `<!--><title><p class="${N}"></title>${AFTER}`],
  ["textarea after an abrupt comment holds text", `<!---><textarea><p class="${N}"></textarea>${AFTER}`],
  ["script after an abrupt comment holds text", `<!--><script>'<p class="${N}">'</script>${AFTER}`],
  ["style after an abrupt comment holds text", `<!---><style>/*<p class="${N}">*/</style>${AFTER}`],
  ["xmp after an abrupt comment", `<!--><xmp><p class="${N}"></xmp>${AFTER}`],
  ["a real comment hides a class", `<!-- <p class="${N}"> -->${AFTER}`],
  ["a comment closed by --!>", `<!-- x --!> <p id=a class="${N}">${AFTER}`],
  // where the separators are
  ["whitespace written as numeric entities", `<p id=a class="${T(12, "&#32;")}">${AFTER}`],
  ["whitespace written as &Tab;", `<p id=a class="${T(12, "&Tab;")}">${AFTER}`],
  ["whitespace as &#10; and &#x0C;", `<p id=a class="${T(6, "&#10;")}&#x0C;${T(6, "&#x0C;", "d")}">${AFTER}`],
  ["a token that starts with an entity", `<p id=a class="${T(5)} &amp;c5 c6 c7">${AFTER}`],
  ["a token that starts after a whitespace entity and an entity", `<p id=a class="${T(5)}&#32;&amp;c5&#32;c6&#32;c7">${AFTER}`],
  // token LIMIT + 1 begins while the value so far is entities only (no raw text between them)
  ["every token and separator is a numeric entity", `<div id=x class="${Array.from({ length: 12 }, (_, i) => `&#${97 + i};&#${97 + i};`).join("&#32;")}"><h1>H</h1></div>${AFTER}`],
  ["entity-led tokens in a long run of entities", `<div id=x class="${Array.from({ length: 12 }, (_, i) => `&#${97 + i};`).join("&#32;")}"><h1>H</h1></div>${AFTER}`],
  ["unquoted value of entities", `<p id=a class=${Array.from({ length: 12 }, (_, i) => `&#${97 + i};`).join("&#x20;")}>${AFTER}`],
  ["named entities mixed with whitespace entities", `<p id=a class="${Array.from({ length: 12 }, (_, i) => `&lt&#${97 + i};`).join("&#32;&#32;")}">${AFTER}`],
  ["entities then raw text then entities", `<p id=a class="&#97;&#32;&#98;&#32;&#99;&#32;&#100;&#32;&#101;&#32;f g&#32;&#104;">${AFTER}`],
  ["NBSP separators are one token", `<p id=a class="${T(12, " ")}">${AFTER}`],
  ["NBSP entity separators are one token", `<p id=a class="${T(12, "&nbsp;")}">${AFTER}`],
  ["U+2003, U+FEFF and VT separators are one token", `<p id=a class="${T(4, " ")}${T(4, "﻿", "d")}${T(4, "\u000b", "e")}">${AFTER}`],
  ["tabs, newlines, form feeds and carriage returns between tokens", `<p id=a class="${T(3, "\t")}\n${T(3, "\r\n", "d")}\f${T(3, "\f", "e")}">${AFTER}`],
  ["leading and trailing whitespace", `<p id=a class="  ${N}  ">${AFTER}`],
  // raw-text-looking elements the tokenizer may or may not treat as raw text
  ["iframe content", `<iframe><p id=a class="${N}"></iframe>${AFTER}`],
  ["noembed content", `<noembed><p id=a class="${N}"></noembed>${AFTER}`],
  ["noframes content", `<noframes><p id=a class="${N}"></noframes>${AFTER}`],
  ["plaintext swallows the rest", `<plaintext><p id=a class="${N}">${AFTER}`],
  ["template content", `<template><p id=a class="${N}"></p></template>${AFTER}`],
  ["a class in a script is text", `<script>var s='<p class="${N}">';</script><b id=a class="${N}">${AFTER}`],
  ["SCRIPT in capitals closes on </script>", `<SCRIPT>'<p class="${N}">'</sCrIpT><b id=a class="${N}">${AFTER}`],
  // which attribute counts
  ["CLASS and Class are not the class linkedom reads", `<p id=a CLASS="${N}"><p id=b Class="${N}">${AFTER}`],
  ["a duplicate class after a short one is ignored", `<p id=a class="c0 c1" class="${N}">${AFTER}`],
  ["a duplicate class after a long one: the first is cut, the second is not counted", `<p id=a class="${N}" class="${T(20, " ", "z")}">${AFTER}`],
  ["a data-class attribute is not a class", `<p id=a data-class="${N}">${AFTER}`],
  ["a class-like name is not a class", `<p id=a class-x="${N}" xclass="${N}">${AFTER}`],
  ["a class inside another attribute's value", `<p id=a title='x class="${N}" y'>${AFTER}`],
  ["a tag inside an attribute value", `<p id=a title="<b class='${N}'>">${AFTER}`],
  ["> inside a quoted value", `<p id=a class="${N} > <img id=victim>">${AFTER}`],
  // quoting and tag shapes
  ["single quotes", `<p id=a class='${N}'>${AFTER}`],
  ["spaces around =", `<p id=a class = "${N}">${AFTER}`],
  ["newlines around =", `<p id=a class\n=\n'${N}'>${AFTER}`],
  ["a slash before the attribute", `<p/class="${N}" id=a>${AFTER}`],
  ["valueless attributes around it", `<p hidden class="${N}" disabled id=a>${AFTER}`],
  ["unquoted value is one token", `<p id=a class=${T(12, "_")}>${AFTER}`],
  ["unquoted value then a second class", `<p id=a class=${T(12, "_")} class="${N}">${AFTER}`],
  ["a quote in the middle of an unquoted value", `<p id=a class=x"${N}"y>${AFTER}`],
  ["svg element", `<svg id=a class="${N}"><circle id=b class='${N}'/></svg>${AFTER}`],
  ["an end tag with a class", `</p class="${N}">${AFTER}`],
  ["self-closing", `<br id=a class="${N}"/>${AFTER}`],
  ["two oversized classes on two tags", `<p id=a class="${N}"><b id=b class="${T(9, " ", "k")}">${AFTER}`],
  ["an oversized class whose value holds & that is not an entity", `<p id=a class="${T(5)} a&b c&d e& f&g=1 h">${AFTER}`],
  // the ends of the page
  ["an unterminated quote at the end of the page", `<p id=z>x</p><p id=a class="${N}`],
  ["a tag cut off before > at the end of the page", `<p id=z>x</p><p id=a class="${N}"`],
  ["an unterminated quote swallows the rest of the page", `<p id=a class="${N}>${AFTER}`],
  ["nothing but the attribute", `<p class="${N}">`],
];

describe("the cut leaves the tree the tokenizer reads, and cuts only the class it reads", () => {
  for (const [name, html] of CASES) test(name, () => expectSameTreeCutOnlyClass(html));

  test("htmlparser2 resolves to the same copy for this package and for linkedom (a split copy would make the cut read another tokenizer)", () => {
    const here = Bun.resolveSync("htmlparser2", import.meta.dir);
    const linkedomDir = Bun.resolveSync("linkedom", import.meta.dir);
    const viaLinkedom = Bun.resolveSync("htmlparser2", linkedomDir);
    expect(here).toBe(viaLinkedom);
  });

  test("the first LIMIT tokens survive, in order, as a prefix", () => {
    const { text } = impl.truncateClassAttributes(`<p id=a class="${N}">`, LIMIT);
    expect(text).toBe(`<p id=a class="${T(LIMIT)} ">`);
  });
});
