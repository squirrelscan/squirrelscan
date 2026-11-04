// #1567: a class value is split as HTML splits it (tab, line feed, form feed, carriage return, space), by the parser and by every
// consumer that tokenises `class`. NBSP, U+2003, U+FEFF and VT stay inside a token, as in a browser.

import { describe, expect, test } from "bun:test";
import { CLASS_SPLIT, parseHTML } from "@squirrelscan/parser/dom";
import { parsePage } from "@squirrelscan/parser";

import { ariaDialogNameRule } from "../src/a11y/aria-dialog-name";
import { hiddenTextRule } from "../src/content/hidden-text";
import { elementSelector } from "../src/element-path";
import { detectFakeAuthOverlay } from "../src/integrity/signals";
import type { RuleContext } from "../src/types";

const url = "https://example.com/";
const FIXED = "position:fixed;inset:0;z-index:9999;width:100%;height:100%";

function fires(css: string, frame: string): boolean {
  const html = `<!doctype html><html><head><title>F</title><style>${css}</style></head><body><main><h1>F</h1>${frame}</main></body></html>`;
  const parsed = parsePage(html, url);
  const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {}, parsed }, parsed, options: {} } as unknown as RuleContext;
  return detectFakeAuthOverlay(ctx) !== null;
}

describe("fake-auth-overlay reads a class with a non-ASCII space as one token", () => {
  const decoy = `.c{${FIXED}} .x{position:static}`;
  test("a plain space makes .x apply, so the decoy hides the cover", () => {
    expect(fires(decoy, `<iframe id="google-auth" class="c cover x" srcdoc=""></iframe>`)).toBe(false);
  });
  for (const [name, entity, literal] of [
    ["NBSP", "&nbsp;", " "],
    ["U+2003", "&#x2003;", " "],
    ["U+FEFF", "&#xFEFF;", "﻿"],
    ["VT", "&#11;", "\u000b"],
  ] as const) {
    test(`${name} as an entity: the frame has no class x, so the cover is found`, () => {
      expect(fires(decoy, `<iframe id="google-auth" class="c cover${entity}x" srcdoc=""></iframe>`)).toBe(true);
    });
    test(`${name} as a literal: the frame has no class x, so the cover is found`, () => {
      expect(fires(decoy, `<iframe id="google-auth" class="c cover${literal}x" srcdoc=""></iframe>`)).toBe(true);
    });
  }
});

describe("other class consumers use the same ASCII-only split", () => {
  test("CLASS_SPLIT splits on the five ASCII characters only", () => {
    expect("a b\tc\nd\fe\rf".split(CLASS_SPLIT)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect("a b c﻿d\u000be".split(CLASS_SPLIT)).toEqual(["a b c﻿d\u000be"]);
  });

  test("elementSelector leaves out a token with an NBSP instead of reading it as two", () => {
    const { document } = parseHTML(`<html><body><div id="x" class="cover&nbsp;x real"></div></body></html>`);
    expect(elementSelector(document.getElementById("x") as never)).toBe("html > body > div#x.real");
  });
});

describe("hidden-text and aria-dialog-name read a class with an NBSP as one token", () => {
  const hiddenCheck = (sep: string) => {
    const html = `<html><head><style>.promo-copy { visibility: hidden; }</style></head><body><div class="promo-copy${sep}x">cheap discount widgets wholesale supplier best prices online now</div></body></html>`;
    const doc = parseHTML(html).document;
    const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {} }, parsed: { document: doc }, options: {} } as unknown as RuleContext;
    return hiddenTextRule.run(ctx).checks[0]!.status;
  };
  test("hidden-text: .hide matches the token 'hide x' with a space and does not with an NBSP", () => {
    expect(hiddenCheck(" ")).not.toBe("pass");
    expect(hiddenCheck("&nbsp;")).toBe("pass");
  });

  const dialogItems = (sep: string) => {
    const html = `<html><body><div role="dialog" class="a${sep}b"></div></body></html>`;
    const doc = parseHTML(html).document;
    const ctx = { page: { url, html, statusCode: 200, loadTime: 0, headers: {} }, parsed: { document: doc }, options: {} } as unknown as RuleContext;
    return JSON.stringify(ariaDialogNameRule.run(ctx).checks);
  };
  test("aria-dialog-name: the descriptor has two classes with a space and one token with an NBSP", () => {
    expect(dialogItems(" ")).toContain("].a.b");
    expect(dialogItems("&nbsp;")).not.toContain("].a.b");
    expect(dialogItems("&nbsp;")).toContain("].a\u00a0b");
  });
});
