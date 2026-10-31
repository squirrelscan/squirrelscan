// #1430: a `script-url` detector reads the page's markup (tags and script text) whether or not script bodies
// are attached, so the standard inline Microsoft Clarity loader is found under the cloud caps and the local
// scan alike, and a vendor named only in a paragraph is not read as that vendor's script.

import { describe, expect, test } from "bun:test";

import { detectTechnologies } from "../src";
import { pageMarkup } from "../src/detect";

const CLARITY_SNIPPET =
  '<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};' +
  't=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];' +
  'y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","abc123");</script>';

const page = (head: string, body = "<p>Hello</p>") =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

function ids(html: string, scripts?: Array<{ url: string; content?: string }>): string[] {
  return detectTechnologies({ url: "https://example.com/", headers: {}, html, ...(scripts ? { scripts } : {}) }).map((t) => t.id);
}

const BODIES = [{ url: "https://example.com/assets/app.js", content: "var a=1;" }];

describe("an inline loader URL is seen with or without script bodies attached", () => {
  test("the standard Clarity snippet: same answer with and without bodies", () => {
    const html = page(`${CLARITY_SNIPPET}<script src="/assets/app.js"></script>`);
    expect(ids(html)).toContain("clarity");
    expect(ids(html, BODIES)).toContain("clarity");
    expect(ids(html, [])).toContain("clarity");
  });

  test("a script src on the page is still matched, and a stored script URL still is", () => {
    expect(ids(page('<script src="https://www.clarity.ms/tag/x"></script>'), BODIES)).toContain("clarity");
    expect(ids(page(""), [{ url: "https://www.clarity.ms/tag/x" }])).toContain("clarity");
  });

  test("the same page gives the same list under both script inputs", () => {
    const html = page(`${CLARITY_SNIPPET}<script src="/assets/app.js"></script>`);
    expect(ids(html, BODIES)).toEqual(ids(html));
  });
});

describe("prose is not a script", () => {
  test("a vendor named only in page text is not detected, with or without bodies", () => {
    const html = page("", "<p>We measure with clarity.ms and compare it with Contentful, a headless CMS.</p>");
    expect(ids(html)).not.toContain("clarity");
    expect(ids(html, BODIES)).not.toContain("clarity");
    expect(ids(html)).not.toContain("contentful");
    expect(ids(html, BODIES)).not.toContain("contentful");
  });

  test("a comment does not count either", () => {
    expect(ids(page("<!-- <script src=\"https://www.clarity.ms/tag/x\"></script> -->"), BODIES)).not.toContain("clarity");
  });
});

describe("pageMarkup", () => {
  test("keeps tags and script text, drops text between tags and comments", () => {
    const markup = pageMarkup('<p>prose clarity.ms</p><!-- note --><img src="/a.png"><SCRIPT>var x="inline";</SCRIPT><p>more</p>');
    expect(markup).toContain('<img src="/a.png">');
    expect(markup).toContain('var x="inline";');
    expect(markup).not.toContain("prose");
    expect(markup).not.toContain("note");
    expect(markup).not.toContain("more");
  });

  test("an unterminated tag or script is kept to the end and the pass stays linear", () => {
    expect(pageMarkup('<script>var a="clarity.ms"')).toContain("clarity.ms");
    expect(pageMarkup('<img src="x')).toContain("<img src");
    const started = performance.now();
    pageMarkup("<script>x</script>".repeat(200_000));
    pageMarkup("<".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("what the markup does not carry (review of #1431)", () => {
  test("data blocks, meta text and links are not a loaded script", () => {
    const html = page(
      '<meta name="description" content="We use Microsoft Clarity (clarity.ms)">' +
        '<script type="application/ld+json">{"sameAs":["https://www.clarity.ms/"]}</script>' +
        '<script id="__NEXT_DATA__" type="application/json">{"u":"https://www.clarity.ms/tag/x"}</script>',
      '<a href="https://www.clarity.ms/">Clarity</a>',
    );
    expect(ids(html, BODIES)).not.toContain("clarity");
    expect(ids(html)).not.toContain("clarity");
  });

  test("a whole inlined bundle is not read for URLs it names in strings, a loader snippet is", () => {
    const bundle = `<script>${'var s="https://www.clarity.ms/tag/x";'.repeat(1_000)}</script>`;
    expect(ids(page(bundle), BODIES)).not.toContain("clarity");
    expect(ids(page(CLARITY_SNIPPET), BODIES)).toContain("clarity");
    expect(ids(page('<script type="text/javascript">var u="https://www.clarity.ms/tag/x";</script>'))).toContain("clarity");
    expect(ids(page('<script type="module">import("https://www.clarity.ms/tag/x")</script>'))).toContain("clarity");
  });

  test("a `>` inside a quoted attribute does not end the tag early", () => {
    expect(ids(page('<img alt="a > b" src="https://www.clarity.ms/x.gif">'), BODIES)).toContain("clarity");
    expect(ids(page('<link onload="this.rel=\'stylesheet\';f=()=>1" rel="preload" href="https://www.clarity.ms/x.css">'), BODIES)).toContain("clarity");
  });

  test("Contentful is a script URL or package name, not the word", () => {
    expect(ids(page('<script src="https://cdn.contentful.com/x.js"></script>'), BODIES)).toContain("contentful");
    expect(ids(page('<script src="https://cdn.jsdelivr.net/npm/contentful@10/dist/contentful.browser.min.js"></script>'))).toContain("contentful");
    expect(ids(page('<script>var a="we compare contentful and others";</script>'), BODIES)).not.toContain("contentful");
  });
});
