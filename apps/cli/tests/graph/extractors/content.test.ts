// Tests for extractors/content.ts — getCleanTextContent / extractContent.
//
// Regression guard for #114: the deep clone + querySelectorAll-strip was
// replaced with an in-place tree walk. Output must stay identical, so these
// tests pin the exact exclusion semantics (tags, aria-hidden, sr-only classes),
// comment handling, and whitespace preservation.

import {
  extractContent,
  getCleanTextContent,
  getMainContent,
} from "@squirrelscan/parser/extractors";
import { describe, it, expect } from "bun:test";
import { parseHTML } from "linkedom";

function parseDoc(html: string) {
  return parseHTML(html).document;
}

describe("getCleanTextContent", () => {
  it("returns empty string when there is no body", () => {
    const doc = parseHTML("<html></html>").document;
    expect(getCleanTextContent(doc)).toBe("");
  });

  it("strips script and style content", () => {
    const doc = parseDoc(
      `<html><body><script>var x=1;</script><p>Hello</p><style>.a{}</style></body></html>`
    );
    expect(getCleanTextContent(doc)).toBe("Hello");
  });

  it("strips media/embed tags (iframe, svg, canvas, video, audio, template, noscript)", () => {
    const doc = parseDoc(
      `<html><body>keep<iframe>IF</iframe><svg><text>S</text></svg><canvas>C</canvas><video>V</video><audio>A</audio><template>T</template><noscript>N</noscript>end</body></html>`
    );
    expect(getCleanTextContent(doc)).toBe("keepend");
  });

  it('strips aria-hidden="true" subtrees but keeps aria-hidden="false"', () => {
    const doc = parseDoc(
      `<html><body><div aria-hidden="true"><span>hidden</span></div><div aria-hidden="false">visible</div></body></html>`
    );
    expect(getCleanTextContent(doc)).toBe("visible");
  });

  it("strips screen-reader class subtrees", () => {
    const doc = parseDoc(
      `<html><body><span class="sr-only">sr</span><span class="visually-hidden">vh</span><span class="screen-reader-text">srt</span>real</body></html>`
    );
    expect(getCleanTextContent(doc)).toBe("real");
  });

  it("ignores comment nodes (matches textContent semantics)", () => {
    const doc = parseDoc(`<html><body>a<!-- comment -->b</body></html>`);
    expect(getCleanTextContent(doc)).toBe("ab");
  });

  it("preserves inter-element whitespace exactly", () => {
    const doc = parseDoc(
      `<html><body><p>one</p>\n  <script>x</script>\n  <p>two</p></body></html>`
    );
    // The whitespace text nodes around the removed <script> remain.
    expect(getCleanTextContent(doc)).toBe("one\n  \n  two");
  });

  it("matches a manual clone-and-strip reference implementation", () => {
    const html = `<html><body>
      <header class="masthead">Site</header>
      <script>var a = 1;</script>
      <main><article><h2>Title</h2><p>Body <b>text</b> &amp; more.</p>
      <div aria-hidden="true">decorative</div>
      <span class="sr-only">screenreader</span></article></main>
      <footer class="colophon">Footer</footer>
    </body></html>`;

    // Reference = the previous implementation (clone + querySelectorAll remove).
    const ref = parseDoc(html).querySelector("body")!.cloneNode(true) as any;
    for (const sel of [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "canvas",
      "video",
      "audio",
      "template",
      '[aria-hidden="true"]',
      ".visually-hidden",
      ".sr-only",
      ".screen-reader-text",
    ]) {
      for (const el of ref.querySelectorAll(sel)) el.remove();
    }
    const expected = (ref.textContent ?? "").trim();

    expect(getCleanTextContent(parseDoc(html))).toBe(expected);
  });
});

describe("extractContent", () => {
  it("computes word count, hash, and ratios from clean text", () => {
    const html = `<html><body><p>The quick brown fox jumps</p><script>noise()</script></body></html>`;
    const doc = parseDoc(html);
    const result = extractContent(doc, html);

    expect(result.wordCount).toBe(5);
    expect(result.textLength).toBe("The quick brown fox jumps".length);
    expect(result.htmlLength).toBe(html.length);
    expect(result.textContent).toBe("The quick brown fox jumps");
    expect(result.isThinContent).toBe(true);
    expect(typeof result.contentHash).toBe("string");
  });
});

describe("getMainContent", () => {
  it("extracts main content while stripping nav/footer/header/aside/script/style", () => {
    const body = `<article><nav>NAVIGATION MENU</nav><p>${"word ".repeat(40)}</p><footer>FOOTER</footer><script>x</script></article>`;
    const doc = parseDoc(`<html><body>${body}</body></html>`);
    const text = getMainContent(doc);
    expect(text).toContain("word");
    expect(text).not.toContain("NAVIGATION");
    expect(text).not.toContain("FOOTER");
  });

  it("falls back to clean body text when no main region is long enough", () => {
    const doc = parseDoc(`<html><body><p>short</p></body></html>`);
    expect(getMainContent(doc)).toBe("short");
  });
});
