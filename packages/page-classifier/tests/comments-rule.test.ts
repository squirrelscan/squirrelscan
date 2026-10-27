// The deterministic comments rule (#2307): which markup is a comment section,
// which look-alikes are not, and the wrapper and reviews cases.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";
import {
  commentLookupOf,
  commentRule,
  commentSectionOf,
  findCommentSections,
  hasUgcRel,
  isCommentToken,
  outermostCommentSections,
} from "../src/comments-rule";

const page = (inner: string) =>
  parseHTML(
    `<html><body><h1>Post title</h1><article><p>Body text</p></article>${inner}</body></html>`,
  ).document;
const linkIn = (inner: string, selector = "a.target") => {
  const el = page(inner).querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return commentSectionOf(el);
};

describe("isCommentToken", () => {
  test.each([
    ["comments", "id"],
    ["comment-12", "id"],
    ["li-comment-12", "id"],
    ["div-comment-12", "id"],
    ["respond", "id"],
    ["disqus_thread", "id"],
    ["commentlist", "class"],
    ["comment-list", "class"],
    ["comments-area", "class"],
    ["comment-body", "class"],
    ["comment", "class"],
    ["ast-comment-list", "class"],
    ["wp-block-post-comments", "class"],
    ["commentsBox", "id"],
    ["comment_text", "class"],
    ["comment-respond", "class"],
  ] as const)("%s (%s) is a comment section token", (token, kind) => {
    expect(isCommentToken(token, kind)).toBe(true);
  });

  test.each([
    ["comments-link", "class"],
    ["comment-count", "class"],
    ["comments-number", "class"],
    ["post-meta-comments", "class"],
    ["recent-comments", "class"],
    ["widget_recent_comments", "class"],
    ["recentcomments", "id"],
    ["has-comments", "class"],
    ["comments-closed", "class"],
    ["no-comments", "class"],
    ["nocomments", "class"],
    ["commentary", "class"],
    ["respond", "class"],
    ["comment-reply-link", "class"],
  ] as const)("%s (%s) is not", (token, kind) => {
    expect(isCommentToken(token, kind)).toBe(false);
  });
});

describe("commentSectionOf", () => {
  test("a link in a WordPress comment author line is in the comments", () => {
    const match = linkIn(
      `<div id="comments" class="comments-area"><ol class="comment-list"><li id="comment-7" class="comment">
        <article id="div-comment-7" class="comment-body"><footer class="comment-meta"><div class="comment-author">
        <a class="url target" rel="external nofollow ugc" href="https://spam.example/">Cheap pills</a></div></footer>
        <div class="comment-content"><p>Great post</p></div></article></li></ol></div>`,
    );
    expect(match?.label).toBe("comments");
    expect(match?.container.getAttribute("class")).toBe("comment-author");
    expect(match?.token).toBe("comment-author");
  });

  test("a link in the reply form is in the comments", () => {
    const match = linkIn(
      `<div id="respond"><form id="commentform"><p class="logged-in-as"><a class="target" href="/wp-login.php">Log in</a></p></form></div>`,
    );
    expect(match?.label).toBe("comments");
  });

  test("the article's own links and a comment-count link are not", () => {
    expect(linkIn(`<p><a class="target" href="https://a.example/">source</a></p>`)).toBeNull();
    expect(
      linkIn(
        `<div class="entry-meta"><span class="comments-link"><a class="target" href="#comments">3 comments</a></span></div>`,
      ),
    ).toBeNull();
  });

  test("a recent-comments widget in the sidebar is not", () => {
    expect(
      linkIn(
        `<aside><section class="widget widget_recent_comments"><ul id="recentcomments"><li class="recentcomments">
          <a class="target" href="https://x.example/">Ann</a></li></ul></section></aside>`,
      ),
    ).toBeNull();
  });

  test("a wrapper holding the page title is refused, and nothing above it counts", () => {
    const doc = parseHTML(
      `<html><body><div class="site comments"><h1>Title</h1><p><a class="target" href="https://a.example/">x</a></p></div></body></html>`,
    ).document;
    expect(commentSectionOf(doc.querySelector("a.target")!)).toBeNull();
  });

  test("WooCommerce product reviews are reviews", () => {
    const match = linkIn(
      `<div id="reviews" class="woocommerce-Reviews"><div id="comments"><ol class="commentlist"><li class="review">
        <a class="target" href="https://b.example/">Bob</a></li></ol></div></div>`,
    );
    expect(match?.label).toBe("reviews");
  });

  test("hops count from the link up to the matching element", () => {
    const match = linkIn(
      `<div id="comments"><p><span><a class="target" href="x">x</a></span></p></div>`,
    );
    expect(match?.hops).toBe(3);
    expect(match?.token).toBe("comments");
  });
});

describe("hasUgcRel and findCommentSections", () => {
  test("rel=ugc is read as a token", () => {
    const doc = page(
      `<a id="u" rel="nofollow UGC" href="x">x</a><a id="n" rel="nofollow" href="y">y</a>`,
    );
    expect(hasUgcRel(doc.querySelector("#u")!)).toBe(true);
    expect(hasUgcRel(doc.querySelector("#n")!)).toBe(false);
  });

  test("one outermost section per thread, none on a page without comments", () => {
    const found = findCommentSections(
      page(
        `<div id="comments"><ol class="commentlist"><li class="comment">a</li><li class="comment">b</li></ol></div>`,
      ),
    );
    expect(found.map((el) => el.getAttribute("id"))).toEqual(["comments"]);
    expect(findCommentSections(page(`<footer><a href="x">x</a></footer>`))).toEqual([]);
  });
});

describe("passes and memos", () => {
  test("an <h1> that is itself the match is not a wrapper holding one", () => {
    const match = linkIn(
      `<div><h1 class="comments-title"><a class="target" href="#respond">3 comments</a></h1></div>`,
    );
    expect(match?.token).toBe("comments-title");
  });

  test("a new pass sees edits made after an earlier one", () => {
    const doc = parseHTML(
      `<html><body><div id="wrap"><div id="comments"><a class="target" href="x">x</a></div></div></body></html>`,
    ).document;
    const link = doc.querySelector("a.target")!;
    expect(commentSectionOf(link)?.label).toBe("comments");
    doc.querySelector("#wrap")!.setAttribute("class", "reviews");
    expect(commentSectionOf(link)?.label).toBe("reviews");
    const thread = doc.querySelector("#comments")!;
    expect(findCommentSections(doc)).toEqual([thread]);
    thread.insertAdjacentHTML("afterbegin", "<h1>Title</h1>");
    expect(findCommentSections(doc)).toEqual([]);
  });

  test("a detached subtree finds its own <h1>", () => {
    const doc = page("");
    const wrapper = doc.createElement("div");
    wrapper.innerHTML = `<div class="comments"><h2><h1>t</h1></h2><a class="target" href="x">x</a></div>`;
    expect(commentSectionOf(wrapper.querySelector("a.target")!)).toBeNull();
  });
});

describe("outermostCommentSections", () => {
  test("two separate threads both count; a refused wrapper gives way to the thread inside it", () => {
    const doc = parseHTML(
      `<html><body><div class="site comments"><h1>Title</h1>
        <div id="comments"><ol class="commentlist"><li class="comment">a</li></ol></div>
        <div id="respond"><form>f</form></div></div></body></html>`,
    ).document;
    const elements = Array.from(doc.body.querySelectorAll("*"));
    const found = outermostCommentSections(elements);
    expect(found.map(({ match }) => match.container.getAttribute("id"))).toEqual([
      "comments",
      "respond",
    ]);
    expect(found.map(({ index }) => elements[index]!.getAttribute("id"))).toEqual([
      "comments",
      "respond",
    ]);
    expect(found[0]!.match.token).toBe("comments");
  });
});

// The page is attacker-controlled: a very deep chain of elements or a huge class attribute must
// cost what a normal page costs (the walks and token splits are capped).
describe("a walk cut short fails closed", () => {
  const BUDGET_MS = 50;
  /** `depth` nested divs under `#root`; the thread container sits `threadAt` levels from the top. */
  function nest(depth: number, threadAt: number | null) {
    const { document } = parseHTML(`<html><body><h1>Title</h1><div id="root"></div></body></html>`);
    let parent = document.getElementById("root")!;
    for (let i = 0; i < depth; i++) {
      const child = document.createElement("div");
      if (i === threadAt) child.setAttribute("class", "comment-list");
      parent.appendChild(child);
      parent = child;
    }
    return parent;
  }

  test("a thread beyond the cap is `truncated`, one inside it is a match", () => {
    // 300 nested divs, the deepest at depth 299 from the top container: 299 hops, over the cap of 256.
    expect(commentLookupOf(nest(300, 0))).toEqual({ truncated: true });
    // The container at index 100 is 199 hops above the deepest div: inside the cap.
    const near = commentLookupOf(nest(300, 100));
    expect(near && "truncated" in near).toBe(false);
    expect(near).toMatchObject({ label: "comments", hops: 199 });
  });

  test("no thread at any depth is null: only a real thread out of reach is truncated", () => {
    const started = performance.now();
    expect(commentLookupOf(nest(300, null))).toBeNull();
    expect(commentLookupOf(nest(5000, null))).toBeNull();
    expect(performance.now() - started).toBeLessThan(BUDGET_MS * 2);
  });

  test("sectionOf stays null for a truncated lookup, for callers that only want a match", () => {
    expect(commentSectionOf(nest(300, 0))).toBeNull();
  });

  test("many elements under one deep chain share one walk, and stay under budget", () => {
    const { document } = parseHTML(`<html><body><h1>Title</h1><div id="root"></div></body></html>`);
    let parent = document.getElementById("root")!;
    for (let i = 0; i < 5000; i++) {
      const child = document.createElement("div");
      if (i === 0) child.setAttribute("class", "comments");
      parent.appendChild(child);
      parent = child;
    }
    const anchors: Element[] = [];
    for (let i = 0; i < 10_000; i++) {
      const a = document.createElement("a");
      parent.appendChild(a);
      anchors.push(a);
    }
    const rule = commentRule();
    const started = performance.now();
    for (const a of anchors) expect(rule.lookup(a)).toEqual({ truncated: true });
    expect(performance.now() - started).toBeLessThan(BUDGET_MS * 4);
  });
});

describe("hostile markup stays cheap", () => {
  const BUDGET_MS = 50;

  /** `depth` nested divs under `top`, returning the deepest one, as an anchor-like target. */
  function chain(depth: number, topClass?: string) {
    const { document } = parseHTML(`<html><body><h1>Title</h1><div id="root"></div></body></html>`);
    let parent = document.getElementById("root")!;
    if (topClass) parent.setAttribute("class", topClass);
    for (let i = 0; i < depth; i++) {
      const child = document.createElement("div");
      parent.appendChild(child);
      parent = child;
    }
    return { document, deepest: parent };
  }

  /** About 1 MB of distinct class tokens (a parser folds repeats, so they must differ). */
  const manyTokens = (): string => Array.from({ length: 130_000 }, (_, i) => `t${i}`).join(" ") + " ";

  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
  };

  test("a 5,000-deep chain: a thread beyond 64 hops is not found, and it is fast", () => {
    const { deepest } = chain(5000, "comments");
    const { value, ms } = timed(() => commentSectionOf(deepest));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("a thread within 64 hops of the element is still found, however deep the page is", () => {
    const { document } = parseHTML(`<html><body><h1>Title</h1><div id="root"></div></body></html>`);
    let parent = document.getElementById("root")!;
    for (let i = 0; i < 5000; i++) {
      const child = document.createElement("div");
      if (i === 4990) child.setAttribute("class", "comment-list");
      parent.appendChild(child);
      parent = child;
    }
    const { value, ms } = timed(() => commentSectionOf(parent));
    expect(value?.label).toBe("comments");
    expect(value?.hops).toBe(9);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("a reviews container beyond 64 hops is not looked for", () => {
    const { document } = parseHTML(
      `<html><body><h1>Title</h1><div id="root" class="reviews"></div></body></html>`,
    );
    let parent = document.getElementById("root")!;
    for (let i = 0; i < 5000; i++) {
      const child = document.createElement("div");
      if (i === 4980) child.setAttribute("class", "comment-list");
      parent.appendChild(child);
      parent = child;
    }
    const { value, ms } = timed(() => commentSectionOf(parent));
    expect(value?.label).toBe("comments");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("a 1 MB class attribute: a comment word past the first 4 KB is ignored, one near the start counts", () => {
    const filler = manyTokens();
    const late = parseHTML(
      `<html><body><h1>T</h1><div class="${filler}comments"><a class="t" href="/a">a</a></div></body></html>`,
    ).document.querySelector("a.t")!;
    const early = parseHTML(
      `<html><body><h1>T</h1><div class="comments ${filler}"><a class="t" href="/a">a</a></div></body></html>`,
    ).document.querySelector("a.t")!;
    const lateRun = timed(() => commentSectionOf(late));
    expect(lateRun.value).toBeNull();
    expect(lateRun.ms).toBeLessThan(BUDGET_MS);
    const earlyRun = timed(() => commentSectionOf(early));
    expect(earlyRun.value?.label).toBe("comments");
    expect(earlyRun.ms).toBeLessThan(BUDGET_MS);
  });

  test("a 1 MB class value with no whitespace and a 1 MB id are cheap and match nothing", () => {
    const blob = "a".repeat(1_000_000);
    const el = parseHTML(
      `<html><body><h1>T</h1><div id="${blob}" class="${blob}"><a class="t" href="/a">a</a></div></body></html>`,
    ).document.querySelector("a.t")!;
    const { value, ms } = timed(() => commentSectionOf(el));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("the whole-page scan stays cheap on the same markup", () => {
    const filler = manyTokens();
    const { document } = parseHTML(
      `<html><body><h1>T</h1><div class="${filler}comments"><p>x</p></div><div class="comments ${filler}"><p>y</p></div></body></html>`,
    );
    const { value, ms } = timed(() => findCommentSections(document));
    expect(value.length).toBe(1);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
