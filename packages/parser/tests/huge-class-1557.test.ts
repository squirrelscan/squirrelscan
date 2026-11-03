// #1557: a class attribute of about 640,000 tokens overflowed linkedom's `className` setter (`classList.add(...tokens)`) and failed the
// whole audit. The parse is contained in `dom.ts`: the oversized class is cut and the rest of the page is read, or the page is read
// empty, and either way it carries a notice. Fixtures are built at runtime from parts; nothing is fetched.

import { describe, expect, test } from "bun:test";

import { MAX_CLASS_TOKENS, parseHTML, parseNotices, truncateClassAttributes } from "../src/dom";

// the documented limit is pinned as a literal: a change to it must change the docs and these tests (#1571)
const LIMIT_20K = 20_000;
import { parsePage } from "../src/index";

const page = (body: string, head = "") => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const tokens = (n: number, unit = "a"): string => Array.from({ length: n }, () => unit).join(" ");

describe("a class attribute that overflowed the parse", () => {
  test("1 million repeated tokens parse: the elements after it reach the document, with a notice", () => {
    const html = page(`<div class="${tokens(1_000_000)}" id="big"><span id="inner">x</span></div><p id="after">marker</p><img src="/m.png" id="img-after">`);
    const { document } = parseHTML(html);
    expect(document.getElementById("inner")?.textContent).toBe("x");
    expect(document.getElementById("after")?.textContent).toBe("marker");
    expect(document.getElementById("img-after")).not.toBeNull();
    expect(document.getElementById("big")?.classList.length).toBe(1); // every token is `a`: one class
    expect(parseNotices(document)).toEqual(["a class attribute of 1,000,000 tokens was cut to the first 20,000 to read the page"]);
  }, 120_000);

  test("distinct tokens: the first 20,000 are kept, in order", () => {
    const names = Array.from({ length: 700_000 }, (_, i) => `c${i}`);
    const { document } = parseHTML(page(`<div class="${names.join(" ")}" id="big"></div><p id="after">m</p>`));
    const classes = document.getElementById("big")!.classList;
    expect(MAX_CLASS_TOKENS).toBe(20_000);
    expect(classes.length).toBe(20_000);
    expect(classes.contains("c0")).toBe(true);
    expect(classes.contains("c19999")).toBe(true);
    expect(classes.contains("c20000")).toBe(false);
    expect(document.getElementById("after")?.textContent).toBe("m");
  }, 120_000);

  test("an svg element's class, single quotes, an upper-case CLASS and an unquoted value", () => {
    const names = Array.from({ length: 900_000 }, (_, i) => `c${i}`).join(" ");
    // linkedom only recognises the literal `class`, so an upper-case CLASS never reached the setter and never overflowed: no notice
    for (const [tag, notices] of [[`<svg class='${tokens(900_000)}' id="x"></svg>`, 1], [`<div CLASS="${tokens(900_000)}" id="x"></div>`, 0], [`<div id="x" class="${tokens(900_000)}"></div>`, 1]] as const) {
      const { document } = parseHTML(page(`${tag}<p id="after">m</p>`));
      expect([tag.slice(0, 20), document.getElementById("after")?.textContent]).toEqual([tag.slice(0, 20), "m"]);
      expect([tag.slice(0, 20), parseNotices(document).length]).toEqual([tag.slice(0, 20), notices]);
    }
    // an unquoted value cannot hold whitespace, so it is one token however long: it never overflowed
    expect(() => parseHTML(page(`<div class=${names.replaceAll(" ", "_")} id="x"></div>`))).not.toThrow();
  }, 120_000);

  test("two oversized attributes on one page are both cut and both noticed", () => {
    const { document } = parseHTML(page(`<div class="${tokens(800_000)}"></div><p class="${tokens(700_000)}" id="second"></p><b id="after">m</b>`));
    expect(parseNotices(document).length).toBe(2);
    expect(document.getElementById("after")?.textContent).toBe("m");
  }, 120_000);

  test("parsePage carries the notices, and a page that parses the first time has none", () => {
    const big = parsePage(page(`<h1>Title</h1><div class="${tokens(900_000)}"></div><h2>Later</h2>`), "https://example.com/");
    expect(big.parseNotices?.length).toBe(1);
    expect(big.content.textContent).toContain("Later");
    const normal = parsePage(page(`<h1>Title</h1><div class="${tokens(30_000)}"></div>`), "https://example.com/");
    expect("parseNotices" in normal).toBe(false);
  }, 120_000);

  test("a page that parses the first time is not touched: a class of 30,000 tokens keeps them all", () => {
    const { document } = parseHTML(page(`<div class="${Array.from({ length: 30_000 }, (_, i) => `k${i}`).join(" ")}" id="n"></div>`));
    expect(document.getElementById("n")!.classList.length).toBe(30_000);
    expect(parseNotices(document)).toEqual([]);
  });
});

describe("truncateClassAttributes pins the limit at 20,000 tokens", () => {
  const cut = (n: number) => truncateClassAttributes(`<p class="${Array.from({ length: n }, (_, i) => `t${i}`).join(" ")}">`, LIMIT_20K);

  test("19,999 and 20,000 tokens are kept whole, 20,001 is cut to 20,000", () => {
    expect(cut(19_999).cut).toEqual([]);
    expect(cut(20_000).cut).toEqual([]);
    const over = cut(20_001);
    expect(over.cut).toEqual([20_001]);
    expect(over.text.endsWith(`t19999 ">`)).toBe(true);
    expect(over.text.includes("t20000")).toBe(false);
  });

  test("the cut is a prefix: the text before and after the value is untouched", () => {
    const html = `<p id="a" class='${tokens(30)}' title="t">x</p>`;
    expect(truncateClassAttributes(html, 10).text).toBe(`<p id="a" class='${tokens(10)} ' title="t">x</p>`);
  });

  test("each of single quotes, no quotes and upper case is asserted", () => {
    // single quotes: cut. unquoted: one token (nothing to cut). upper case: not the class linkedom reads (nothing to cut).
    const results = [
      [`<p id=a class='${tokens(500)}' title="t">`, [500]],
      [`<p id=a class=${tokens(500).replaceAll(" ", "_")} data-x=1>`, []],
      [`<p ID=a CLASS="${tokens(500)}" data-x=1>`, []],
    ] as const;
    for (const [html, expected] of results) expect([html.slice(0, 22), truncateClassAttributes(html, 100).cut]).toEqual([html.slice(0, 22), expected as unknown as number[]]);
  });

  test("a valueless attribute, a slash before the class and a repeated attribute are read through", () => {
    for (const tag of [`<p hidden disabled class="${tokens(500)}">`, `<input required/class="${tokens(500)}">`, `<p hidden class="${tokens(500)}" hidden>`]) {
      expect([tag.slice(0, 22), truncateClassAttributes(tag, 100).cut]).toEqual([tag.slice(0, 22), [500]]);
    }
  });

  test("an unterminated quote and a tag cut off by the end of the page cut nothing: the page has no such element", () => {
    expect(truncateClassAttributes(`<p class="${tokens(500)}`, 100).cut).toEqual([]);
    expect(truncateClassAttributes(`<p class="${tokens(500)}"`, 100).cut).toEqual([]);
  });

  test("the cost is linear: 10 MiB with no big class, and 10 MiB of hostile shapes", () => {
    const plain = `<p class="a b c">x</p>`.repeat(Math.ceil((10 * 1_048_576) / 22));
    let started = performance.now();
    expect(truncateClassAttributes(plain, MAX_CLASS_TOKENS).cut).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
    const hostile = `<?x <b class="${tokens(30)} > ">`.repeat(Math.ceil((10 * 1_048_576) / 100));
    started = performance.now();
    expect(truncateClassAttributes(hostile, 20).cut).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
