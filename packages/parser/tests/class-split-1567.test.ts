// #1567: a class value is split as HTML splits it, on tab, line feed, form feed, carriage return and space only. linkedom split on
// JavaScript's `\s` and rejoined with a space, so NBSP, U+2003, U+FEFF and VT inside a class read back as two classes.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "../src/dom";

const read = (value: string) => {
  const { document } = parseHTML(`<html><body><div id="x" class="${value}"></div></body></html>`);
  const el = document.getElementById("x")!;
  return { tokens: Array.from(el.classList as Iterable<string>), attribute: el.getAttribute("class") };
};

const CHARS: Array<[string, string, string]> = [
  ["NBSP", " ", "&nbsp;"],
  ["U+2003", " ", "&#x2003;"],
  ["U+FEFF", "﻿", "&#xFEFF;"],
  ["VT", "\u000b", "&#11;"],
];

describe("class tokens keep non-ASCII whitespace and VT inside a token", () => {
  for (const [name, literal, entity] of CHARS) {
    test(`${name} as a literal`, () => {
      expect(read(`cover${literal}x y`)).toEqual({ tokens: [`cover${literal}x`, "y"], attribute: `cover${literal}x y` });
    });
    test(`${name} as an entity`, () => {
      expect(read(`cover${entity}x y`)).toEqual({ tokens: [`cover${literal}x`, "y"], attribute: `cover${literal}x y` });
    });
  }

  test("the five ASCII whitespace characters still split, as a literal and as entities", () => {
    expect(read("a\tb\nc\fd\re f").tokens).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(read("a&#9;b&#10;c&#12;d&#13;e&#32;f").tokens).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("classList sees the token a browser sees", () => {
    const { document } = parseHTML(`<html><body><div id="x" class="cover&nbsp;x"></div></body></html>`);
    expect(Array.from(document.getElementById("x")!.classList as Iterable<string>)).toEqual(["cover\u00a0x"]);
    expect(document.getElementById("x")!.classList.contains("cover x")).toBe(true);
  });

  test("setting className later splits the same way", () => {
    const { document } = parseHTML(`<html><body><div id="x"></div></body></html>`);
    const el = document.getElementById("x")!;
    el.setAttribute("class", "a b c");
    expect(Array.from(el.classList as Iterable<string>)).toEqual(["a b", "c"]);
  });

  test("a 640,000-piece class separated by NBSP is one token: it neither overflows nor needs a cut", () => {
    const value = Array.from({ length: 640_000 }, (_, i) => `c${i}`).join(" ");
    const { document } = parseHTML(`<html><body><div id="x" class="${value}"></div><p id="after">t</p></body></html>`);
    expect(document.getElementById("x")!.classList.length).toBe(1);
    expect(document.getElementById("after")?.textContent).toBe("t");
  }, 60_000);
});
