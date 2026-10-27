// The link-section walk climbs an anchor's ancestors. It must not recurse once per level: a hostile
// page nesting hundreds of thousands of elements would overflow the stack and take the whole audit
// down with a RangeError. The answers on normal pages stay exactly what they were.

import { describe, expect, test } from "bun:test";
import type { Element } from "linkedom";

import { makeSectionResolver } from "../src/extractors/link-section";
import { extractLinks } from "../src/extractors/links";
import { parseDocument } from "../src/index";

const URL = "https://example.com/post";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

/** A body holding `depth` nested divs under `outer` (a tag name, or none), one anchor at the bottom. */
function deepDocument(depth: number, outer?: string) {
  const doc = parseDocument(page(""));
  let parent = doc.querySelector("body")!;
  if (outer) {
    const wrap = doc.createElement(outer);
    parent.appendChild(wrap);
    parent = wrap;
  }
  for (let i = 0; i < depth; i++) {
    const div = doc.createElement("div");
    parent.appendChild(div);
    parent = div;
  }
  const a = doc.createElement("a");
  a.setAttribute("href", "/deep");
  a.textContent = "deep";
  parent.appendChild(a);
  return { doc, anchor: a as unknown as Element };
}

describe("link section on a very deep page", () => {
  test("200k nested divs: no stack overflow, and the answer is still right", () => {
    const plain = deepDocument(200_000);
    expect(() => makeSectionResolver()(plain.anchor)).not.toThrow();
    expect(makeSectionResolver()(plain.anchor)).toBe("unknown");

    const inFooter = deepDocument(200_000, "footer");
    expect(makeSectionResolver()(inFooter.anchor)).toBe("footer");
  });

  test("the link extractor reads the deep anchor too", () => {
    const { doc } = deepDocument(200_000, "nav");
    const links = extractLinks(doc as never, URL);
    expect(links.map((l) => [l.href, l.section])).toEqual([["https://example.com/deep", "navigation"]]);
  });
});

/** The recursive walk this replaced, with its own copy of the per-element rule: the reference. */
function referenceResolver(): (element: Element) => string {
  const CHROME = new Set(["header", "footer", "navigation", "sidebar"]);
  const ROLES: Record<string, string> = {
    banner: "header",
    contentinfo: "footer",
    navigation: "navigation",
    complementary: "sidebar",
    main: "content",
  };
  const COMMENTS =
    /(?:^|[\s_-])(?:comments|comment-?list|comment-?thread|comment-?section|comments-?area|disqus_thread|fb-comments|commento)(?:$|[\s_-])/;
  const own = (element: Element): string | null => {
    const tag = element.tagName?.toLowerCase();
    if (tag === "nav") return "navigation";
    if (tag === "aside") return "sidebar";
    if (tag === "header") return "header";
    if (tag === "footer") return "footer";
    if (tag === "main" || tag === "article") return "content";
    const role = element.getAttribute?.("role")?.toLowerCase();
    if (role && ROLES[role]) return ROLES[role]!;
    const id = element.getAttribute?.("id");
    const cls = element.getAttribute?.("class");
    if (id && COMMENTS.test(id.toLowerCase())) return "comments";
    if (cls && COMMENTS.test(cls.toLowerCase())) return "comments";
    return null;
  };
  const memo = new Map<Element, string>();
  const resolve = (element: Element): string => {
    const cached = memo.get(element);
    if (cached) return cached;
    const parent = element.parentElement;
    const inherited = parent ? resolve(parent) : "unknown";
    let section = inherited;
    if (!CHROME.has(inherited)) {
      const mine = own(element);
      if (mine) {
        const scoped = (mine === "header" || mine === "footer") && inherited !== "unknown";
        if (!scoped) section = mine;
      }
    }
    memo.set(element, section);
    return section;
  };
  return resolve;
}

const FIXTURES = [
  `<header><a href="/h">h</a><nav><a href="/hn">hn</a></nav></header><main><a href="/c">c</a>` +
    `<article><header><a href="/ah">ah</a></header><footer><a href="/af">af</a></footer></article></main>` +
    `<footer><nav><a href="/fn">fn</a></nav></footer><a href="/x">x</a>`,
  `<div role="banner"><a href="/b">b</a></div><div role="main"><div id="comments"><a href="/cm">cm</a>` +
    `<footer><a href="/cf">cf</a></footer></div></div><div class="comment-list"><a href="/cl">cl</a></div>` +
    `<aside><div class="comments"><a href="/sc">sc</a></div></aside>`,
  `<section><header><a href="/sh">sh</a></header><div role="navigation"><a href="/rn">rn</a></div></section>` +
    `<div role="contentinfo"><header><a href="/ch">ch</a></header></div><div role="complementary"><a href="/rc">rc</a></div>`,
];

describe("the iterative walk answers what the recursive one did", () => {
  for (const [i, body] of FIXTURES.entries()) {
    test(`fixture ${i + 1}, in document order and in reverse`, () => {
      const doc = parseDocument(page(body));
      const anchors = [...doc.querySelectorAll("a[href]")] as unknown as Element[];
      const expected = anchors.map(referenceResolver());
      expect(anchors.map(makeSectionResolver())).toEqual(expected);
      // Resolving deep anchors first fills the memo from below; the answers must not change.
      expect([...anchors].reverse().map(makeSectionResolver()).reverse()).toEqual(expected);
    });
  }
});
