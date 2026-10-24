// elementPlacer (#2307): one element's region and section on a classified
// page, the comments rule first.

import { describe, expect, test } from "bun:test";

import { parseHTML } from "@squirrelscan/parser/dom";
import { elementPlacer } from "../src/placement";
import { classifyDocument } from "../src/predict";

const URL = "https://example.com/blog/post";
const HTML = `<!doctype html><html><head><title>t</title></head><body>
<header><nav><a id="home" href="/">Home</a></nav></header>
<main><article><h1>Post</h1><p>Body with <a id="cite" href="https://a.example.org/">a source</a>.</p></article>
<div id="comments" class="comments-area"><ol class="comment-list"><li id="comment-9" class="comment">
  <div class="comment-author"><a id="spam" rel="nofollow ugc" href="https://spam.example.org/">Pills</a></div>
</li></ol></div></main>
<footer><p><a id="foot" href="https://shop.example.org/">Shop</a></p></footer>
</body></html>`;

function setup() {
  const { document } = parseHTML(HTML);
  const elements: unknown[] = [];
  const result = classifyDocument(document, URL, { elementsOut: elements });
  const at = (id: string) => document.querySelector(`#${id}`)!;
  return { result, elements, at, place: () => elementPlacer(result, elements) };
}

describe("elementPlacer", () => {
  test("a comment link: the thread from the rule, the region from its ancestors", () => {
    const { elements, at, place } = setup();
    const spam = place()(at("spam"));
    expect(spam.section).toMatchObject({
      label: "comments",
      confidence: 1,
      source: "rules",
      evidence: "comment-author",
      hops: 1,
    });
    expect(elements[spam.section!.nodeId!]).toBe(at("spam").parentElement);
    // With no model, the comment list is the nearest node with a region answer.
    expect(spam.region).toMatchObject({
      label: "content_block",
      source: "rules",
      tag: "ol",
      hops: 3,
    });
    expect(elements[spam.region!.nodeId]).toBe(at("spam").closest("ol"));
  });

  test("chrome links: the nearest region, no section", () => {
    const { at, place } = setup();
    const placeOf = place();
    expect(placeOf(at("home")).region).toMatchObject({ label: "navigation", tag: "nav", hops: 1 });
    expect(placeOf(at("foot")).region).toMatchObject({ label: "footer", tag: "footer", hops: 2 });
    expect(placeOf(at("home")).section).toBeNull();
    expect(placeOf(at("foot")).section).toBeNull();
    expect(placeOf(at("cite")).section).toBeNull();
  });

  test("a head section comes from the nearest node, and loses to the rule", () => {
    const { result, elements, at, place } = setup();
    const nodeOf = (el: unknown) => result.nodes.find((n) => elements[n.nodeRef.nodeId] === el);
    nodeOf(at("foot").closest("footer"))!.section = {
      label: "newsletter_signup",
      confidence: 0.97,
      source: "model",
    };
    // As if the head had answered on the comment list.
    nodeOf(at("spam").closest("ol"))!.section = {
      label: "social_share",
      confidence: 0.99,
      source: "model",
    };
    const placeOf = place();
    expect(placeOf(at("foot")).section).toMatchObject({
      label: "newsletter_signup",
      source: "model",
      hops: 2,
    });
    expect(placeOf(at("spam")).section).toMatchObject({ label: "comments", source: "rules" });
  });

  test("an element from another parse: no region, the rule still reads its markup", () => {
    const { place } = setup();
    const other = parseHTML(HTML).document;
    const placeOf = place();
    expect(placeOf(other.querySelector("#foot"))).toEqual({ region: null, section: null });
    const spam = placeOf(other.querySelector("#spam"));
    expect(spam.region).toBeNull();
    expect(spam.section).toMatchObject({ label: "comments", nodeId: null });
  });
});

describe("a thread out of the rule's reach", () => {
  test("is placed nowhere: no region, no section, `truncated`, never a fall back to content", () => {
    const { document } = parseHTML(
      `<html><body><main><h1>Title</h1><div id="root"></div></main></body></html>`,
    );
    let parent = document.getElementById("root")!;
    for (let i = 0; i < 300; i++) {
      const child = document.createElement("div");
      if (i === 0) child.setAttribute("class", "comments");
      parent.appendChild(child);
      parent = child;
    }
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "/x");
    parent.appendChild(anchor);
    const elements: unknown[] = [];
    const result = classifyDocument(document, "https://example.com/", { elementsOut: elements });
    const started = performance.now();
    const placed = elementPlacer(result, elements)(anchor);
    expect(placed).toEqual({ region: null, section: null, truncated: true });
    expect(performance.now() - started).toBeLessThan(50);
  });
});

