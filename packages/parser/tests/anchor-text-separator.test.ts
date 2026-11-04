// Anchor text: a gap at block-level boundaries between child nodes, none at inline ones (#110).
//
// `textContent` glues a card link's heading and description into one unmatchable word, which
// produced hundreds of phantom anchor mismatches on one audited site. Both link extractors (the
// stored one in html.ts that parsePage uses, and extractors/links.ts) share one function.

import { describe, expect, test } from "bun:test";

import { anchorText, anchorTextResult } from "../src/extractors/anchor-text";
import { extractLinks } from "../src/extractors/links";
import { parseHTML } from "../src/dom";
import { parsePage } from "../src/html";

const CARD = `<a href="/c"><h3>Carpentry</h3><p>Structural &amp; finish carpentry</p><span>See details</span></a>`;
const CARD_TEXT = "Carpentry Structural & finish carpentry See details";

function viaExtractLinks(html: string): string[] {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return extractLinks(document, "https://example.com/").map((l) => l.text);
}

function viaParsePage(html: string): string[] {
  return parsePage(`<html><body>${html}</body></html>`, "https://example.com/").links.map(
    (l) => l.text,
  );
}

describe.each([
  ["extractors/links.ts", viaExtractLinks],
  ["parsePage (html.ts)", viaParsePage],
])("anchor text in %s", (_name, texts) => {
  test("a card wrapping a heading and a description is space separated", () => {
    expect(texts(CARD)).toEqual([CARD_TEXT]);
  });

  test("inline elements add no gap: mid-word and before punctuation", () => {
    expect(texts(`<a href="/a">Hello <b>world</b>!</a>`)).toEqual(["Hello world!"]);
    expect(texts(`<a href="/a">Re<b>start</b></a>`)).toEqual(["Restart"]);
    expect(texts(`<a href="/a"><span>A</span><span>B</span></a>`)).toEqual(["AB"]);
  });

  test("text that was already separated is unchanged", () => {
    expect(texts(`<a href="/a">  plain  text </a>`)).toEqual(["plain  text"]);
    expect(texts(`<a href="/a"><div>one</div> <div>two</div></a>`)).toEqual(["one two"]);
  });

  test("an image-only anchor is empty", () => {
    expect(texts(`<a href="/b"><img src="x.png"></a>`)).toEqual([""]);
  });
});

test("the DOM function a rule re-reads an anchor with returns the stored text", () => {
  const html = `<html><body>${CARD}</body></html>`;
  const { document } = parseHTML(html);
  const el = document.querySelector("a")!;
  expect(anchorText(el)).toBe(parsePage(html, "https://example.com/").links[0]!.text);
});

describe("anchor text edge cases", () => {
  test("script, style, template and noscript text is not link text", () => {
    expect(
      viaParsePage(
        `<a href="/f"><svg><style>.a{fill:none}</style><title>Icon</title></svg>Fridge<script>var x=1</script><template>t</template><noscript>n</noscript></a>`,
      ),
    ).toEqual(["Icon Fridge"]);
    expect(viaExtractLinks(`<a href="/f"><svg><style>.a{}</style></svg>Fridge</a>`)).toEqual([
      "Fridge",
    ]);
  });

  test("button, label and select children are separated", () => {
    expect(viaParsePage(`<a href="/f"><button>Buy</button><label>now</label></a>`)).toEqual([
      "Buy now",
    ]);
  });

  test("100,000 nested spans do not overflow the stack", () => {
    const depth = 100_000;
    const html = `<a href="/x">${"<span>".repeat(depth)}deep${"</span>".repeat(depth)}</a>`;
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    expect(anchorText(document.querySelector("a")!)).toBe("deep");
    // Through the full parse, error path included: it must not throw.
    expect(() =>
      parsePage(`<html><body>${html}</body></html>`, "https://example.com/"),
    ).not.toThrow();
  }, 60_000);

  test("the stored parse marks nofollow, sponsored and ugc links", () => {
    const links = parsePage(
      `<html><body><a href="/a" rel="nofollow">a</a><a href="/b" rel="sponsored noopener">b</a><a href="/c" rel="ugc">c</a><a href="/d">d</a></body></html>`,
      "https://example.com/",
    ).links;
    expect(links.map((l) => l.isNofollow === true)).toEqual([true, true, true, false]);
    expect(links[3]!.rel).toBeUndefined();
    expect(links[0]!.rel).toEqual(["nofollow"]);
  });

  test("160,000 block children are linear, through parsePage", () => {
    const n = 160_000;
    const html = `<html><body><a href="/x">${"<div>word</div>".repeat(n)}</a></body></html>`;
    const start = performance.now();
    const links = parsePage(html, "https://example.com/").links;
    const ms = performance.now() - start;
    expect(links[0]!.text.split(" ").length).toBe(n);
    // The pre-fix quadratic scan took 9 s here; the whole parse is dominated by the DOM build.
    const { document } = parseHTML(html);
    const t0 = performance.now();
    anchorText(document.querySelector("a")!);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);

  test("an invalid href takes the catch path and still reads the text", () => {
    const depth = 50_000;
    const html = `<html><body><a href="http://[bad">${"<span>".repeat(depth)}deep${"</span>".repeat(depth)}</a></body></html>`;
    const links = parsePage(html, "https://example.com/").links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ error: "Invalid URL format", text: "deep" });
  }, 60_000);

  test("an inline display:block style is a boundary", () => {
    expect(
      viaParsePage(
        `<a href="/f"><span style="display:block">Fridge</span><span style="display: flex">repairs</span></a>`,
      ),
    ).toEqual(["Fridge repairs"]);
    expect(viaParsePage(`<a href="/f">Fridge<br>repairs</a>`)).toEqual(["Fridge repairs"]);
  });

  test("text joined from adjacent elements with no boundary is reported as glued", () => {
    const glue = (html: string) => {
      const { document } = parseHTML(`<html><body>${html}</body></html>`);
      return anchorTextResult(document.querySelector("a")!);
    };
    expect(glue(`<a href="/f"><span>Fridge</span><span>repairs</span></a>`)).toEqual({
      text: "Fridgerepairs",
      glued: true,
      parts: ["Fridge", "repairs"],
    });
    expect(glue(`<a href="/f"><div>Fridge</div><div>repairs</div></a>`).glued).toBe(false);
    expect(glue(`<a href="/f">plain text</a>`).glued).toBe(false);
    const stored = parsePage(
      `<html><body><a href="/f"><span>Fri</span><span>dge</span></a><a href="/g">x</a></body></html>`,
      "https://example.com/",
    ).links;
    expect(stored[0]!.textGlued).toBe(true);
    expect(stored[1]!.textGlued).toBeUndefined();
  });

  test("a glued card stores its pieces for the rule", () => {
    const links = parsePage(
      `<html><body><a href="/brands/lg"><span class="block">LG</span><span class="block">See details</span></a></body></html>`,
      "https://example.com/",
    ).links;
    expect(links[0]).toMatchObject({
      text: "LGSee details",
      textGlued: true,
      textParts: ["LG", "See details"],
    });
  });
});
