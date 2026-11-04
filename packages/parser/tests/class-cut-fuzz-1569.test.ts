// #1569: a differential run of the class cut over generated documents. Each document is a seeded random join of the hostile
// fragments from the issue (bogus comments, processing instructions, CDATA, abrupt comments, raw-text elements, entity and
// non-ASCII separators, case and duplicate attributes, unfinished tags) and plain markup, with a small limit so every page parses
// without overflowing. The oracle is linkedom itself: after the cut the tree must be the original tree, with only the class value
// of an element whose class is over the limit shortened: no element lost or moved, no text changed, no other class cut.
// Fixtures are built from parts and the run is deterministic (a failing index and its markup are in the message).

import { expect, test } from "bun:test";

import { Parser } from "htmlparser2";
import { parseHTML as linkedomParseHTML } from "linkedom";

import { parseHTML, truncateClassAttributes } from "../src/dom";

const LIMIT = 4;
const CLASS_SPLIT = /[ \t\n\f\r]+/;
const DOCS = 100_000;

// Every token is unique across the whole document (a counter), because linkedom's class list collapses a repeated token and would
// hide a cut: a value that swallows later fragments must still count each of its tokens.
let uid = 0;
const U = (prefix = "c"): string => `${prefix}${uid++}`;
const T = (n: number, sep = " ", prefix = "c"): string => Array.from({ length: n }, () => U(prefix)).join(sep);
const N = (): string => T(LIMIT + 4);

const FRAGMENTS: Array<() => string> = [
  () => `<?x <b class="${N()} > <img id=victim> ">`,
  () => `<!x <b class='${N()} > <img id=victim> '>`,
  () => `<![CDATA[ <b class="${N()} > <img id=victim> "> ]]>`,
  () => `<!<d class='${N()} > <img id=victim> '>`,
  () => `</<p class='${N()} > <img id=victim> '>`,
  () => `<!-->`,
  () => `<!--->`,
  () => `<!-- <p class="${N()}"> -->`,
  () => `<!-- x --!>`,
  () => `<title><p class="${N()}"></title>`,
  () => `<textarea><p class="${N()}"></textarea>`,
  () => `<script>'<p class="${N()}">'</script>`,
  () => `<style>/*<p class="${N()}">*/</style>`,
  () => `<xmp><p class="${N()}"></xmp>`,
  () => `<iframe><p class="${N()}"></iframe>`,
  () => `<noembed><p class="${N()}"></noembed>`,
  () => `<noframes><p class="${N()}"></noframes>`,
  () => `<template><p class="${N()}"></p></template>`,
  () => `<p class="${T(LIMIT + 4, "&#32;")}">`,
  () => `<p class="${T(LIMIT + 4, "&Tab;")}">`,
  () => `<p class="${T(LIMIT + 4, "&nbsp;")}">`,
  () => `<p class="${T(LIMIT + 4, " ")}">`,
  () => `<p class="${T(2, " ")}${T(2, "﻿", "d")}${T(2, "\u000b", "e")}${T(4, " ", "f")}">`,
  () => `<p class="${T(LIMIT)} &amp;${U()} ${T(3)}">`,
  () => `<p class="${T(LIMIT + 3, "\t\n")}">`,
  () => `<p CLASS="${N()}">`,
  () => `<p Class="${N()}">`,
  () => `<p class="${T(2)}" class="${N()}">`,
  () => `<p class="${N()}" class="${T(20, " ", "z")}">`,
  () => `<p data-class="${N()}" class-x="${N()}">`,
  () => `<p title='x class="${N()}" y'>`,
  () => `<p title="<b class='${N()}'>">`,
  () => `<p class="${N()} > <img id=victim>">`,
  () => `<p class='${N()}'>`,
  () => `<p class = "${N()}">`,
  () => `<p/class="${N()}" id=a>`,
  () => `<p class=${T(LIMIT + 4, "_")}>`,
  () => `<p class=${T(LIMIT + 4, "&#x20;")}>`,
  () => `<p hidden class="${N()}" disabled>`,
  () => `<svg class="${N()}"><circle class='${N()}'/></svg>`,
  () => `<br class="${N()}"/>`,
  () => `</p class="${N()}">`,
  () => `<p class="${N()}`,
  () => `<p class="${N()}"`,
  () => `<plaintext>`,
  () => `<img id=victim>`,
  () => `<p id=ok>text &amp; more</p>`,
  () => `<div><span>plain</span></div>`,
  () => `<b class="${T(2)}">`,
  () => `</b>`,
  () => `</div>`,
  () => `text`,
  () => `<a href="x">link</a>`,
  () => `<![if x]>`,
  () => `<!doctype html>`,
];

/** mulberry32: a small seeded generator, so a failing document reproduces from its index. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A line of the tree after the cut: an element whose class list is over the limit keeps its first LIMIT tokens. */
const clip = (repeats: boolean) => (line: string): string => {
  if (repeats) return line;
  const match = /^(<\S+ id=.* class=)(\[.*\])>$/.exec(line);
  if (!match) return line;
  const tokens = JSON.parse(match[2]!) as string[];
  return tokens.length > LIMIT ? `${match[1]}${JSON.stringify(tokens.slice(0, LIMIT))}>` : line;
};

/**
 * The string the cut sees on the real path: `parseHTML` parses a page that builds no `<html>` again inside a wrapper (a page that
 * ends in a tag the tokenizer never finishes is the case: the wrapper finishes it), and a RangeError, hence the cut, happens there.
 */
function parsedAs(html: string): string {
  return linkedomParseHTML(html).document.documentElement ? html : `<html><head></head><body>${html}</body></html>`;
}

interface Oracle {
  /** Token counts of each over-limit `class` the tokenizer reports on a finished tag, in order. */
  overLimit: number[];
  /** A value repeats a token: linkedom's class list collapses it, so the class lists of the two trees cannot be compared exactly. */
  repeats: boolean;
}

/** htmlparser2's own parse (the options linkedom builds it with): the first `class` of each finished tag, split on HTML whitespace. */
function oracle(html: string): Oracle {
  const result: Oracle = { overLimit: [], repeats: false };
  const parser = new Parser(
    {
      onopentag(_name, attribs) {
        const value = attribs["class"];
        if (value === undefined) return;
        const tokens = value.split(CLASS_SPLIT).filter(Boolean);
        if (new Set(tokens).size !== tokens.length) result.repeats = true;
        if (tokens.length > LIMIT) result.overLimit.push(tokens.length);
      },
    },
    { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false },
  );
  parser.write(html);
  parser.end();
  return result;
}

function dump(html: string, withClasses: boolean): string[] {
  const { document } = parseHTML(html);
  const lines: string[] = [];
  const walk = (node: any): void => {
    for (const child of Array.from(node.childNodes as ArrayLike<any>)) {
      if (child.nodeType === 1) {
        const reads = Array.from(child.attributes as ArrayLike<{ name: string }>).some((attribute) => attribute.name === "class");
        const tokens: string[] = reads && withClasses ? Array.from(child.classList as Iterable<string>) : [];
        lines.push(`<${child.localName} id=${child.getAttribute("id")} class=${JSON.stringify(tokens)}>`);
        walk(child);
      } else lines.push(`#${child.nodeType}:${JSON.stringify(child.textContent)}`);
    }
  };
  walk(document);
  return lines;
}

test(
  `${DOCS.toLocaleString("en-US")} generated documents: the cut changes only the value of an over-limit class`,
  () => {
    const next = rng(1569);
    let withCut = 0;
    let exact = 0;
    for (let i = 0; i < DOCS; i++) {
      const parts = 2 + Math.floor(next() * 5);
      let html = "";
      for (let k = 0; k < parts; k++) html += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!();
      html = parsedAs(html);
      const want = oracle(html);
      const { text, cut } = truncateClassAttributes(html, LIMIT);
      const where = `document ${i}: ${JSON.stringify(html)}`;
      if (JSON.stringify(cut) !== JSON.stringify(want.overLimit)) throw new Error(`cut counts differ in ${where}: got ${JSON.stringify(cut)}, want ${JSON.stringify(want.overLimit)}`);
      if (cut.length === 0) {
        if (text !== html) throw new Error(`text changed without a cut in ${where}`);
        continue;
      }
      withCut++;
      // elements, ids and text always compare; the class lists compare too unless a value repeats a token
      const before = dump(html, !want.repeats);
      const after = dump(text, !want.repeats);
      if (JSON.stringify(after) !== JSON.stringify(before.map(clip(want.repeats)))) throw new Error(`tree differs in ${where}`);
      if (!want.repeats) exact++;
    }
    expect(exact).toBeGreaterThan(DOCS / 5);
    // the generator must exercise the cut, not only the no-op path
    expect(withCut).toBeGreaterThan(DOCS / 4);
  },
  600_000,
);
