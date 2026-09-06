// collectTextExcluding's `separator`: skipping a subtree GLUES its neighbours,
// so `Ã<code>x</code>©` reads back as `Ã©` — a sequence in neither fragment.
// Callers that scan the output for character sequences (content/mojibake) must
// pass a boundary. The default stays "" because getCleanTextContent feeds
// contentHash, and changing its bytes would move every stored hash.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "../src/dom";

import { collectTextExcluding, tagExcluder } from "../src/extractors/dom-text";

const body = (html: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document.querySelector("body")!;

const isCode = tagExcluder(new Set(["code"]));

describe("collectTextExcluding separator", () => {
  test("defaults to gluing, matching remove-then-textContent exactly", () => {
    const html = "<p>Ã<code>literal</code>©</p>";
    const a = body(html);
    const b = body(html);
    for (const el of b.querySelectorAll("code")) el.remove();

    expect(collectTextExcluding(a, isCode)).toBe(b.textContent || "");
    expect(collectTextExcluding(a, isCode)).toBe("Ã©");
  });

  test("a separator stands in for each skipped subtree", () => {
    expect(collectTextExcluding(body("<p>Ã<code>literal</code>©</p>"), isCode, "\n")).toBe("Ã\n©");
  });

  test("one separator per skipped subtree, not per skipped text node", () => {
    const text = collectTextExcluding(
      body("<p>a<code>one<em>two</em></code>b<code>three</code>c</p>"),
      isCode,
      "\n",
    );
    expect(text).toBe("a\nb\nc");
  });

  test("surviving text is untouched when nothing is excluded", () => {
    expect(collectTextExcluding(body("<p>plain copy</p>"), isCode, "\n")).toBe("plain copy");
  });

  test("does not mutate the DOM it reads", () => {
    const el = body("<p>a<code>x</code>b</p>");
    collectTextExcluding(el, isCode, "\n");
    expect(el.querySelectorAll("code").length).toBe(1);
  });
});

// The boundary is emitted on BOTH sides of a matching element. Entering alone
// separates two adjacent BLOCKS, which is all content/placeholder-text needs,
// but leaves a block glued to inline content that follows it — where
// content/unrendered-markup then reads a match belonging to neither element.
describe("collectTextExcluding — block boundaries", () => {
  const isTd = tagExcluder(new Set(["td"]));
  const isBlock = tagExcluder(new Set(["p", "li", "div"]));

  test("without isBoundary, adjacent cells fuse into one word", () => {
    // `.textContent` semantics, and the reason the option exists.
    expect(collectTextExcluding(body("<tr><td>Author</td><td>undefined</td></tr>"), isCode)).toBe(
      "Authorundefined",
    );
  });

  test("isBoundary wraps each matching element, so cells never fuse", () => {
    expect(
      collectTextExcluding(body("<tr><td>Author</td><td>undefined</td></tr>"), isCode, "\n", isTd),
    ).toBe("\nAuthor\n\nundefined\n");
  });

  test("a boundary separates, it never joins", () => {
    // Text already flowing through one element must not gain a break inside it.
    expect(collectTextExcluding(body("<td>two words</td>"), isCode, "\n", isTd)).toBe(
      "\ntwo words\n",
    );
  });

  test("an empty separator disables boundaries as well as skip markers", () => {
    expect(collectTextExcluding(body("<tr><td>a</td><td>b</td></tr>"), isCode, "", isTd)).toBe("ab");
  });

  test("omitted, sibling blocks glue together", () => {
    expect(collectTextExcluding(body("<p>a</p><p>b</p>"), isCode, "\n")).toBe("ab");
  });

  test("nested blocks each contribute their own pair", () => {
    expect(collectTextExcluding(body("<div>x<p>y</p></div>"), isCode, "\n", isBlock)).toBe(
      "\nx\ny\n\n",
    );
  });

  test("non-matching elements are transparent", () => {
    expect(collectTextExcluding(body("<p>a<span>b</span>c</p>"), isCode, "\n", isBlock)).toBe(
      "\nabc\n",
    );
  });

  test("excluded subtrees still emit exactly one separator", () => {
    expect(collectTextExcluding(body("<p>a<code>x</code>b</p>"), isCode, "\n", isBlock)).toBe(
      "\na\nb\n",
    );
  });

  test("a boundary element that is ALSO excluded is only excluded", () => {
    // Exclusion wins, and contributes one separator rather than three.
    const both = tagExcluder(new Set(["div"]));
    expect(collectTextExcluding(body("a<div>x</div>b"), both, "\n", both)).toBe("a\nb");
  });

  test("text on both sides of a block cannot glue across it", () => {
    // The closing half of the boundary is what this pins: `*` before a block and
    // `*` after it must not read back as a matched pair.
    expect(collectTextExcluding(body("a *<p>b</p>c* d"), isCode, "\n", isBlock)).toBe(
      "a *\nb\nc* d",
    );
  });

  test("the root itself never emits a boundary", () => {
    expect(collectTextExcluding(body("plain"), isCode, "\n", () => true)).toBe("plain");
  });
});
