// #1550 review: the pass that takes inert regions out must never take out a real tag. Each shape below hides a REAL tag (R) behind
// a boundary the tokenizer reads differently from a naive scan; the tag must still be detected. Built from parts, synthetic hosts.

import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { ALL_FINGERPRINTS, detectTechnologies } from "../src";
import { DATA_SCRIPT_TYPE } from "../src/detect";
import { COMMENT_MARKER_FINGERPRINTS, pageViews } from "../src/inert-regions";

setDefaultTimeout(60_000);

const ids = (html: string): string[] => detectTechnologies({ url: "https://example.com/", headers: {}, html }).map((t) => t.id);
const detects = (html: string, id: string): boolean => ids(html).includes(id);
const shell = (body: string): string => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const views = (html: string) => pageViews(html, (t) => DATA_SCRIPT_TYPE.test(t));

const STRIPE = '<script src="https://js.stripe.com/v3/"></script>';
const YOUTUBE = '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>';
const LOADER = '<script>var u="https://www.youtube.com/embed/abcdefghijk";</script>';
const CLOSE = "--" + ">"; // a comment closer, built so no line here is a bare one
const BANG_CLOSE = "--!" + ">";
const OPEN = "<!" + "--";

describe("comments end where the tokenizer ends them", () => {
  test("`<!-->` and `<!--->` are empty comments: a real tag after them is read", () => {
    for (const opener of [`${OPEN}>`, `${OPEN}->`]) {
      const html = shell(`${opener}${YOUTUBE}${CLOSE}`);
      expect(detects(html, "youtube-embed"), opener).toBe(true);
    }
  });
  test("a comment also ends at --!>", () => {
    expect(detects(shell(`${OPEN} x ${BANG_CLOSE}${YOUTUBE}${CLOSE}`), "youtube-embed")).toBe(true);
  });
  test("a comment that does end is still taken out, whichever closer it has", () => {
    for (const close of [CLOSE, BANG_CLOSE]) expect(detects(shell(`${OPEN} ${YOUTUBE} ${close}`), "youtube-embed"), close).toBe(false);
    expect(views(`a${OPEN}>b`).clean).toBe("ab");
    expect(views(`a${OPEN}->b`).clean).toBe("ab");
    expect(views(`a${OPEN}-->b`).clean).toBe("ab");
    expect(views(`a${OPEN}--->b`).clean).toBe("ab");
  });
  test("a bogus comment, a doctype and a processing instruction end at the first `>`, not at a later closer", () => {
    for (const head of ["<!x <!-- >", "<?x <!-- >", "</ x <!-- >", "<!DOCTYPE <!-- >"]) {
      expect(detects(shell(`${head}${YOUTUBE}${CLOSE}`), "youtube-embed"), head).toBe(true);
    }
    expect(detects(shell(`</>${OPEN} ${YOUTUBE} ${CLOSE}`), "youtube-embed")).toBe(false);
    // a bogus end tag ends at the first `>`, even inside quotes, so the comment after it is a comment
    expect(detects(shell(`</ a=">" ${OPEN} ${YOUTUBE} ${CLOSE}`), "youtube-embed")).toBe(false);
  });
});

describe("raw text is not markup", () => {
  test("a comment opener inside xmp, noscript, iframe, noembed, noframes, style, textarea and title does not hide what follows", () => {
    for (const name of ["xmp", "noscript", "iframe", "noembed", "noframes", "style", "textarea", "title"]) {
      const html = shell(`<${name}>${OPEN}</${name}>${YOUTUBE}${CLOSE}`);
      expect(detects(html, "youtube-embed"), name).toBe(true);
    }
  });
  test("the end of raw text needs whitespace, `/` or `>` after its name: `</xmpx` does not end it", () => {
    const whole = `<xmp>a</xmpx>${OPEN} y ${CLOSE}</xmp>b`;
    expect(views(whole).clean).toBe(whole);
    for (const sep of [" ", "/", ">", "\n", "\t"]) expect(views(`<xmp>${OPEN}</xmp${sep}>q${OPEN}a${CLOSE}`).clean, JSON.stringify(sep)).toBe(`<xmp>${OPEN}</xmp${sep}>q`);
  });
  test("style and textarea text is kept in every view", () => {
    for (const name of ["style", "textarea"]) {
      const html = `<${name}>${OPEN} keep ${CLOSE}</${name}>`;
      expect(views(html), name).toEqual({ markup: html, clean: html, commented: html });
    }
  });
  test("plaintext makes the rest of the page text: it stays", () => {
    const html = `<plaintext>${OPEN} ${YOUTUBE} ${CLOSE}`;
    expect(views(html).clean).toBe(html);
  });
  test("svg CDATA is text, not a bogus comment", () => {
    const html = shell(`<svg><![CDATA[ a>b ${OPEN} ]]></svg>${YOUTUBE}${CLOSE}`);
    expect(detects(html, "youtube-embed")).toBe(true);
  });
});

describe("a script ends where script data ends", () => {
  test("`</scriptx` does not end it, so a comment opener in its string is not markup", () => {
    expect(detects(shell(`<script>var a="</scriptx>${OPEN}";</script>${YOUTUBE}<!-- end ${CLOSE}`), "youtube-embed")).toBe(true);
    for (const sep of [" ", "/", ">", "\n"]) {
      expect(views(`<script>a</script${sep}>${OPEN}c${CLOSE}`).clean, JSON.stringify(sep)).toBe(`<script>a</script${sep}>`);
    }
  });
  test("the escaped and double-escaped states: `</script>` inside `<script>` inside a comment does not end the script", () => {
    const html = shell(`<script>${OPEN}<script></script>${OPEN}</script>${YOUTUBE}${CLOSE}`);
    expect(detects(html, "youtube-embed")).toBe(true);
    const plain = shell(`<script>${OPEN} x </script>${YOUTUBE}${OPEN} y ${CLOSE}`);
    expect(detects(plain, "youtube-embed")).toBe(true);
    // after the comment closer the script is plain again
    expect(views(`<script>${OPEN}<script>${CLOSE}</script>${OPEN}q${CLOSE}`).clean).toBe(`<script>${OPEN}<script>${CLOSE}</script>`);
  });
  test("a script that never ends keeps everything after it, a data one included", () => {
    expect(detects(shell(`<script type="application/json">{"a":${JSON.stringify(YOUTUBE)}}`), "youtube-embed")).toBe(true);
    const html = `<script type="application/json">{"a":1}`;
    expect(views(html).clean).toBe(html);
  });
  test("a self-closing `<script />` still opens a script: the body is data", () => {
    expect(detects(shell(`<script type="application/json" />${JSON.stringify(YOUTUBE)}</script>`), "youtube-embed")).toBe(false);
    expect(views(`<script type="application/json"/>{"a":1}</script>`).clean).toBe(`<script type="application/json"/></script>`);
  });
});

describe("a tag is read as the tokenizer reads it", () => {
  test("`type=` inside another attribute's value is not the type", () => {
    expect(detects(shell(`<script data-a=" type=application/json">var u="https://www.youtube.com/embed/abcdefghijk";</script>`), "youtube-embed")).toBe(true);
    expect(detects(shell(`<script data-a='type="application/json"'>var u="https://www.youtube.com/embed/abcdefghijk";</script>`), "youtube-embed")).toBe(true);
  });
  test("the first `type` wins, as in a browser", () => {
    expect(detects(shell(`<script type="text/javascript" type="application/json">var u="https://www.youtube.com/embed/abcdefghijk";</script>`), "youtube-embed")).toBe(true);
    expect(detects(shell(`<script type="application/json" type="text/javascript">var u="https://www.youtube.com/embed/abcdefghijk";</script>`), "youtube-embed")).toBe(false);
  });
  test("a quoted value holding `>` and a comment opener does not end the tag or start a comment", () => {
    expect(detects(shell(`<a title="a > ${OPEN}">${YOUTUBE}${CLOSE}`), "youtube-embed")).toBe(true);
    expect(detects(shell(`<a title='a > ${OPEN}'>${YOUTUBE}${CLOSE}`), "youtube-embed")).toBe(true);
  });
  test("a quote opens a value only after `=`: an apostrophe in a name or an unquoted value does not", () => {
    expect(detects(shell(`<a it's>${OPEN} ${YOUTUBE} ${CLOSE}`), "youtube-embed")).toBe(false);
    expect(views(`<a b=c"d>${OPEN}x${CLOSE}`).clean).toBe(`<a b=c"d>`);
  });
  test("a tag over 64 KB, or one that never ends, stops the pass: the rest of the page stays", () => {
    const long = `<div ${"a ".repeat(40_000)}>`;
    const rest = `${OPEN} ${YOUTUBE} ${CLOSE}`;
    expect(views(long + rest).clean).toBe(long + rest);
    const under = `<div ${"a ".repeat(30_000)}>`;
    expect(views(under + rest).clean).toBe(under);
    expect(views(`<div ${OPEN}x${CLOSE}`).clean).toBe(`<div ${OPEN}x${CLOSE}`);
  });
});

describe("a template pairs only with the end tags the pass saw as tags", () => {
  const holds: Array<[string, string]> = [
    ["an attribute", `<p title="<template>">x</p>`],
    ["a script string", `<script>var a="<template>";</script>`],
    ["an inline script", `<script>document.write("<template>")</script>`],
    ["a comment", `${OPEN} <template> ${CLOSE}`],
    ["a textarea", `<textarea><template></textarea>`],
    ["a title", `<title><template></title>`],
  ];
  for (const [what, inner] of holds) {
    test(`the word inside ${what} does not open one: the real end tag closes the real template, and what follows is read`, () => {
      expect(detects(shell(`<template>${inner}</template>${YOUTUBE}</template>`), "youtube-embed"), what).toBe(true);
    });
  }
  test("a template word hidden in raw text outside any template does not pair with a later end tag", () => {
    for (const name of ["xmp", "noscript", "iframe", "noembed", "noframes"]) {
      expect(detects(shell(`<${name}><template></${name}>${YOUTUBE}</template>`), "youtube-embed"), name).toBe(true);
    }
  });
  test("a declarative shadow root pairs with its own end tag, so it does not steal an outer template's", () => {
    const html = shell(`<template><template shadowrootmode="open"></template>${YOUTUBE}</template>${LOADER}`);
    expect(detects(html, "youtube-embed")).toBe(true); // the loader after the outer end is live
    expect(views(`<template><template shadowrootmode="open">a</template>b</template>c`).markup).toBe("c");
    const shadow = `<template shadowrootmode="open">a</template>c`;
    expect(views(shadow).markup).toBe(shadow); // a shadow root's content is rendered: it stays
  });
  test("a nested pair is taken out whole, and what follows its end is read", () => {
    expect(views(`<template><template>a</template>b</template>c`).markup).toBe("c");
    expect(views(`<template><template>a</template>b`).markup).toBe(`<template><template>a</template>b`.replace("<template>a</template>", ""));
  });
  test("a template inside foreign content is not a template", () => {
    expect(detects(shell(`<svg><template>${JSON.stringify(YOUTUBE)}</template></svg>`), "youtube-embed")).toBe(true);
  });
});

describe("foreign content is kept whole, and the pass stops when it cannot tell", () => {
  test("an svg or math region is kept as written, and what follows it is read", () => {
    const svg = `<svg><title>t</title>${OPEN} a ${CLOSE}<path d="M0"/></svg>`;
    expect(views(`${svg}${OPEN}b${CLOSE}`).clean).toBe(svg);
    expect(views(`<math><mi>x</mi></math>${OPEN}b${CLOSE}`).clean).toBe(`<math><mi>x</mi></math>`);
    expect(views(`<svg/>${OPEN}b${CLOSE}`).clean).toBe(`<svg/>`);
    expect(views(`<svg><svg></svg><g/></svg>${OPEN}b${CLOSE}`).clean).toBe(`<svg><svg></svg><g/></svg>`);
    const nested = `<svg><svg></svg>${OPEN} x ${CLOSE}</svg>`; // the inner end does not end the region
    expect(views(`${nested}${OPEN}b${CLOSE}`).clean).toBe(nested);
    const cdata = `<svg><![CDATA[ a>b ${OPEN} ]]></svg>`;
    expect(views(`${cdata}${OPEN}c${CLOSE}`).clean).toBe(cdata);
  });
  test("an element that breaks out of foreign content, plaintext, markup inside a raw-text element, or an end that never comes stops the pass", () => {
    for (const inner of ["<p>", "<div>", "<font>", "<plaintext>", "<style>a<x></style>", "<script>a<x></script>", "<title>a<x></title>", `<![CDATA[x`, `${OPEN}x`]) {
      const html = `<svg>${inner}</svg>${OPEN}b${CLOSE}`;
      expect(views(html).clean, inner).toBe(html);
    }
    const open = `<svg><g>${OPEN}b${CLOSE}`;
    expect(views(open).clean).toBe(open);
  });
  test("a style or title with text only inside svg is read as foreign and as raw text alike, so the pass goes on", () => {
    const html = `<svg><style>.a{}</style><title>t</title></svg>${OPEN}b${CLOSE}`;
    expect(views(html).clean).toBe(`<svg><style>.a{}</style><title>t</title></svg>`);
  });
});

describe("the allowlist guard also covers evidence that is comment text without delimiters", () => {
  // Fingerprints whose html pattern mentions a word that marker comments use ("generated by", "optimized by", "plugin",
  // "begin", an app block, a banner) but that read a real tag, URL or class, not a comment. Each was read when it was added.
  const REVIEWED_NOT_COMMENT = new Set(["wordpress", "complianz", "docusaurus", "hexo", "termly", "gravity-forms"]);
  const WORDS = /(?:powered|generated|optimi[sz]ed|cached|created|built|made|produced|rendered|served) by|\b(?:begin|end)\b|plugin|banner|copyright|\bby @|fontawesome|font awesome|app block|shopify:\\?\/\\?\/apps/i;
  test("every fingerprint whose html pattern uses such a word is a marker fingerprint or reviewed as not one", () => {
    for (const fp of ALL_FINGERPRINTS) {
      for (const d of fp.detectors) {
        if (d.type !== "html" || !WORDS.test(d.pattern.source)) continue;
        expect(COMMENT_MARKER_FINGERPRINTS.has(fp.id) || REVIEWED_NOT_COMMENT.has(fp.id), `${fp.id}: ${d.pattern.source.slice(0, 80)}`).toBe(true);
      }
    }
  });
  test("the reviewed ids exist and are not also in the allowlist", () => {
    const known = new Set(ALL_FINGERPRINTS.map((fp) => fp.id));
    for (const id of REVIEWED_NOT_COMMENT) {
      expect(known.has(id), id).toBe(true);
      expect(COMMENT_MARKER_FINGERPRINTS.has(id), id).toBe(false);
    }
  });
});
