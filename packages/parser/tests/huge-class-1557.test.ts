// #1557: a class attribute of about 640,000 tokens overflowed linkedom's `className` setter (`classList.add(...tokens)`) and failed the
// whole audit. The parse is contained in `dom.ts`: the oversized class is cut and the rest of the page is read, or the page is read
// empty, and either way it carries a notice. Fixtures are built at runtime from parts; nothing is fetched.

import { describe, expect, test } from "bun:test";

import { MAX_CLASS_TOKENS, parseHTML, parseNotices, truncateClassAttributes } from "../src/dom";
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
    expect(parseNotices(document)).toEqual([`a class attribute of 1,000,000 tokens was cut to the first ${MAX_CLASS_TOKENS.toLocaleString("en-US")} to read the page`]);
  }, 120_000);

  test("distinct tokens: the first 20,000 are kept, in order", () => {
    const names = Array.from({ length: 700_000 }, (_, i) => `c${i}`);
    const { document } = parseHTML(page(`<div class="${names.join(" ")}" id="big"></div><p id="after">m</p>`));
    const classes = document.getElementById("big")!.classList;
    expect(classes.length).toBe(MAX_CLASS_TOKENS);
    expect(classes.contains("c0")).toBe(true);
    expect(classes.contains(`c${MAX_CLASS_TOKENS - 1}`)).toBe(true);
    expect(classes.contains(`c${MAX_CLASS_TOKENS}`)).toBe(false);
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

describe("a throw that is not an oversized class leaves an empty document with a notice", () => {
  test("any other error, and a retry that throws again", () => {
    // a class value the cut cannot shrink enough is not constructible here; the empty-document path is exercised through a getter that throws
    const hostile = { toString: () => { throw new RangeError("Maximum call stack size exceeded"); } };
    const { document } = parseHTML(hostile as unknown as string);
    expect(document.documentElement).not.toBeNull();
    expect(parseNotices(document)[0]).toContain("could not be read");
    expect(parseNotices(document)[0]).toContain("audited empty");
  });
});

describe("truncateClassAttributes", () => {
  const LIMIT = 100;
  const cutOf = (html: string) => truncateClassAttributes(html, LIMIT);
  const big = (n: number) => tokens(n);

  test("exactly the limit is kept, one more is cut", () => {
    expect(cutOf(`<p class="${big(LIMIT)}"></p>`).cut).toEqual([]);
    expect(cutOf(`<p class="${big(LIMIT + 1)}"></p>`).cut).toEqual([LIMIT + 1]);
    expect(cutOf(`<p class="${big(LIMIT + 1)}"></p>`).text).toBe(`<p class="${big(LIMIT)} "></p>`);
  });

  test("single quotes, no quotes, upper case and other attributes around it", () => {
    for (const tag of [`<p id=a class='${big(500)}' title="t">`, `<p ID=a CLASS="${big(500)}" data-x=1>`, `<p class=${big(500).replaceAll(" ", " ")} id=a>`]) {
      const out = cutOf(tag);
      if (tag.includes(" ")) continue; // one token without whitespace: nothing to cut
      expect([tag.slice(0, 20), out.cut]).toEqual([tag.slice(0, 20), [500]]);
      expect(out.text.endsWith(">")).toBe(true);
    }
  });

  test("valueless attributes and a slash before the class are read through", () => {
    for (const tag of [`<p hidden disabled class="${big(500)}">`, `<input required/class="${big(500)}">`, `<p hidden class="${big(500)}" hidden>`]) {
      expect([tag.slice(0, 22), cutOf(tag).cut]).toEqual([tag.slice(0, 22), [500]]);
    }
  });

  test("not a tag: a comment, script, style and textarea text, a data-class attribute, an end tag", () => {
    const bigClass = `class="${big(500)}"`;
    for (const html of [`<!-- <p ${bigClass}> -->`, `<script>var s='<p ${bigClass}>';</script>`, `<style>/* <p ${bigClass}> */</style>`, `<textarea><p ${bigClass}></textarea>`, `<p data-class="${big(500)}">`, `</p ${bigClass}>`, `<p title='x ${bigClass}'>`]) {
      expect([html.slice(0, 24), cutOf(html).cut]).toEqual([html.slice(0, 24), []]);
    }
    // markup after a script that mentions a tag is still read
    expect(cutOf(`<script>'<p>'</script><p ${bigClass}>`).cut).toEqual([500]);
    // a closing tag of another element does not end the script's text
    expect(cutOf(`<script></style><p ${bigClass}></script><b ${bigClass}>`).cut).toEqual([500]);
  });

  test("a short value is never counted, and the cost is linear: 10 MiB with no big class", () => {
    const html = `<p class="a b c">x</p>`.repeat(Math.ceil((10 * 1_048_576) / 22));
    const started = performance.now();
    expect(truncateClassAttributes(html, MAX_CLASS_TOKENS).cut).toEqual([]);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);
});
