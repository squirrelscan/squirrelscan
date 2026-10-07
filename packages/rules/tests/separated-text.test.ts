// getSeparatedText: element text with a space between every pair of adjacent nodes.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "@squirrelscan/parser/dom";

import { getSeparatedText } from "../src/content/text-content";

function body(html: string) {
  return parseHTML(`<html><body>${html}</body></html>`).document.querySelector("body")!;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

describe("getSeparatedText", () => {
  test("separates sibling elements that .textContent glues together", () => {
    const el = body("<span>Published</span><span>March 12, 2024</span>Read more");

    expect(el.textContent).toBe("PublishedMarch 12, 2024Read more");
    expect(collapse(getSeparatedText(el))).toBe("Published March 12, 2024 Read more");
  });

  test("separates block siblings and inline siblings alike", () => {
    expect(collapse(getSeparatedText(body("<td>Author</td><td>undefined</td>")))).toBe(
      "Author undefined",
    );
    expect(collapse(getSeparatedText(body("<p>a</p><b>b</b><i>c</i>d")))).toBe("a b c d");
  });

  test("keeps the text of one text node whole", () => {
    expect(getSeparatedText(body("<p>March 12, 2024</p>")).trim()).toBe("March 12, 2024");
  });

  test("does not read script, style, noscript or template content", () => {
    const el = body(
      "<p>shown</p><script>var a = 1</script><style>.x{}</style>" +
        "<noscript>fallback</noscript><template>inert</template><p>also</p>",
    );

    expect(collapse(getSeparatedText(el))).toBe("shown also");
  });

  test("drops the tags it is told to skip, along with everything inside them", () => {
    const el = body('Published <a href="/x">March <b>12</b>, 2024</a> by Nik');
    const skip = new Set(["a"]);

    expect(collapse(getSeparatedText(el, skip))).toBe("Published by Nik");
    // Without the skip set the link's text is read.
    expect(collapse(getSeparatedText(el))).toContain("March");
  });

  test("does not mutate the document", () => {
    const el = body('<p>a</p><a href="/x">b</a><script>c</script>');
    const before = el.innerHTML;

    getSeparatedText(el, new Set(["a"]));

    expect(el.innerHTML).toBe(before);
  });
});
