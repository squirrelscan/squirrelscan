// The page classifier as a second source for LinkData.section (#2307): markup wins, the model fills
// the silence, comments stay rule-only. The parser takes the classifier as an injected hook, so
// these tests use a fake placer and need no model.

import { describe, expect, test } from "bun:test";

import type { PageClassifierHook } from "../src/classifier-hook";
import type { LinkPlacement, PlacedLabel } from "../src/extractors/link-section";

import { extractLinks } from "../src/extractors/links";
import { parsePage } from "../src/html";
import { parseDocument } from "../src/index";

const URL = "https://example.com/post";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

const model = (label: string, confidence = 0.9): PlacedLabel => ({
  label,
  confidence,
  source: "model",
});

/** A hook whose placer answers from a table keyed by the anchor's text. */
function hookFor(
  answers: Record<string, Partial<LinkPlacement>>,
  calls: string[] = [],
): PageClassifierHook {
  return () => ({
    classification: { pageType: { label: "article", confidence: 0.8, source: "model" }, degraded: "" },
    placeLink: (element) => {
      const text = element.textContent ?? "";
      calls.push(text);
      const answer = answers[text];
      return answer ? { region: null, section: null, ...answer } : null;
    },
  });
}

function links(body: string, classify?: PageClassifierHook) {
  return parsePage(page(body), URL, classify ? { classify } : undefined).links;
}

describe("link section from the classifier", () => {
  test("without a hook nothing is added: no source keys, no classification", () => {
    const parsed = parsePage(page(`<a href="/a">a</a>`), URL);
    expect(parsed.links[0]).toEqual({
      url: "https://example.com/a",
      text: "a",
      isInternal: true,
      isChrome: false,
      section: "unknown",
    });
    expect("classification" in parsed).toBe(false);
  });

  test("markup wins: the header, the footer and a comment thread are never asked or overridden", () => {
    const calls: string[] = [];
    const out = links(
      `<footer><a href="/f">f</a></footer><header><nav><a href="/h">h</a></nav></header>` +
        `<main><div id="comments"><a href="/c">c</a></div></main>`,
      hookFor(
        {
          f: { section: model("pagination") },
          h: { section: model("breadcrumbs") },
          c: { section: model("related_content") },
        },
        calls,
      ),
    );
    expect(out.map((l) => [l.text, l.section, l.sectionSource])).toEqual([
      ["f", "footer", undefined],
      ["h", "header", undefined],
      ["c", "comments", undefined],
    ]);
    expect(calls).toEqual([]);
  });

  test("a section purpose refines a navigation or sidebar landmark; nothing else does", () => {
    const out = links(
      `<nav><a href="/p">p</a></nav><nav><a href="/b">b</a></nav><aside><a href="/r">r</a></aside>` +
        `<nav><a href="/x">x</a></nav><aside><a href="/y">y</a></aside><nav><a href="/z">z</a></nav>`,
      hookFor({
        p: { section: model("pagination", 0.96) },
        b: { section: model("breadcrumbs", 0.9) },
        r: { section: model("related_content", 0.8) },
        // A region answer, a comments answer and a rule-sourced answer do not refine a landmark.
        x: { region: model("content_block", 0.99) },
        y: { section: model("comments", 0.99) },
        z: { section: { label: "reviews", confidence: 1, source: "rules" } },
      }),
    );
    expect(out.map((l) => [l.text, l.section, l.sectionSource, l.sectionConfidence])).toEqual([
      ["p", "pagination", "model", 0.96],
      ["b", "breadcrumbs", "model", 0.9],
      ["r", "related_content", "model", 0.8],
      ["x", "navigation", undefined, undefined],
      ["y", "sidebar", undefined, undefined],
      ["z", "navigation", undefined, undefined],
    ]);
  });

  test("the model fills a markup unknown from its region answer", () => {
    const out = links(
      `<div><a href="/h">h</a></div><div><a href="/b">b</a></div><div><a href="/s">s</a></div>` +
        `<div><a href="/x">x</a></div>`,
      hookFor({
        h: { region: model("site_header", 0.91) },
        b: { region: model("content_block", 0.8) },
        s: { region: model("site_chrome", 0.85) },
        x: { region: model("form", 0.99) },
      }),
    );
    expect(out.map((l) => [l.text, l.section])).toEqual([
      ["h", "header"],
      ["b", "content"],
      ["s", "unknown"],
      ["x", "unknown"],
    ]);
    const header = out[0]!;
    expect(header.sectionSource).toBe("model");
    expect(header.sectionConfidence).toBe(0.91);
    expect(out[2]!.sectionSource).toBeUndefined();
  });

  test("a model section purpose beats the markup's weak content and a bare unknown", () => {
    const out = links(
      `<main><a href="/p">p</a></main><div><a href="/r">r</a></div>`,
      hookFor({
        p: { region: model("main_content"), section: model("pagination", 0.97) },
        r: { section: model("related_content", 0.8) },
      }),
    );
    expect(out.map((l) => [l.text, l.section, l.sectionSource, l.sectionConfidence])).toEqual([
      ["p", "pagination", "model", 0.97],
      ["r", "related_content", "model", 0.8],
    ]);
  });

  test("comments are rule-only: a model comments or reviews answer is ignored", () => {
    const out = links(
      `<main><a href="/c">c</a></main><div><a href="/r">r</a></div>`,
      hookFor({
        c: { section: model("comments", 0.99) },
        r: { section: model("reviews", 0.99), region: model("content_block") },
      }),
    );
    // c stays the markup's content; r has no purpose, so its region answers.
    expect(out.map((l) => [l.text, l.section])).toEqual([
      ["c", "content"],
      ["r", "content"],
    ]);
  });

  test("a comment thread the classifier's own rule found counts, with no model provenance", () => {
    // Thread markup the parser's own pattern does not match (`li-comment-12`, `respond`) but the
    // classifier's rule does: the link is in the comments, and the answer is markup-sourced.
    const out = links(
      `<main><a href="/c">c</a></main><div><a href="/r">r</a></div>`,
      hookFor({
        c: { section: { label: "comments", confidence: 1, source: "rules" } },
        r: { section: { label: "reviews", confidence: 1, source: "rules" } },
      }),
    );
    expect(out.map((l) => [l.text, l.section])).toEqual([
      ["c", "comments"],
      ["r", "comments"],
    ]);
    for (const link of out) expect("sectionSource" in link).toBe(false);
  });

  test("a rules-source answer from the classifier carries no model provenance", () => {
    const out = links(
      `<div><a href="/a">a</a></div>`,
      hookFor({ a: { region: { label: "main_content", confidence: 1, source: "rules" } } }),
    );
    expect(out[0]).toMatchObject({ section: "content" });
    expect("sectionSource" in out[0]!).toBe(false);
  });

  test("a placer that throws leaves the markup answer", () => {
    const hook: PageClassifierHook = () => ({
      classification: { pageType: { label: "other", confidence: 0, source: "rules" }, degraded: "" },
      placeLink: () => {
        throw new Error("boom");
      },
    });
    expect(links(`<main><a href="/a">a</a></main>`, hook)[0]!.section).toBe("content");
  });
});

describe("a truncated placement fails closed", () => {
  const truncatedHook: PageClassifierHook = () => ({
    classification: { pageType: { label: "other", confidence: 0, source: "rules" }, degraded: "" },
    // What the classifier says for a link in a comment thread nested out of its reach: nothing
    // placed, and a region answer that must not be used.
    placeLink: () => ({
      region: { label: "content_block", confidence: 0.99, source: "model" },
      section: { label: "pagination", confidence: 0.99, source: "model" },
      truncated: true,
    }),
  });

  test("unknown stays unknown and content becomes unknown, whatever the model said", () => {
    const out = links(
      `<div><a href="/u">u</a></div><main><a href="/c">c</a></main>`,
      truncatedHook,
    );
    expect(out.map((l) => [l.text, l.section, l.sectionSource])).toEqual([
      ["u", "unknown", undefined],
      ["c", "unknown", undefined],
    ]);
  });

  test("a landmark the markup names is kept", () => {
    const out = links(`<nav><a href="/n">n</a></nav><footer><a href="/f">f</a></footer>`, truncatedHook);
    expect(out.map((l) => [l.text, l.section])).toEqual([
      ["n", "navigation"],
      ["f", "footer"],
    ]);
  });
});

describe("page classification on the parsed page", () => {
  test("is stored when the hook answers and absent when it returns null or throws", () => {
    const classify = hookFor({});
    expect(parsePage(page(`<p>x</p>`), URL, { classify }).classification).toEqual({
      pageType: { label: "article", confidence: 0.8, source: "model" },
      degraded: "",
    });
    const none = parsePage(page(`<p>x</p>`), URL, { classify: () => null });
    expect("classification" in none).toBe(false);
    const threw = parsePage(page(`<p>x</p>`), URL, {
      classify: () => {
        throw new Error("boom");
      },
    });
    expect("classification" in threw).toBe(false);
    expect(threw.links).toEqual([]);
  });

  test("it does not replace the schema and URL page type", () => {
    const parsed = parsePage(page(`<p>x</p>`), "https://example.com/", { classify: hookFor({}) });
    expect(parsed.pageType).toBe("home");
  });
});

describe("producers agree", () => {
  test("extractLinks with a placer gives the same sections as parsePage", () => {
    const body =
      `<footer><a href="/f">f</a></footer><main><a href="/p">p</a></main><div><a href="/b">b</a></div>`;
    const answers = {
      p: { section: model("pagination", 0.95) },
      b: { region: model("content_block", 0.85) },
    };
    const stored = links(body, hookFor(answers)).map((l) => [
      l.text,
      l.section,
      l.sectionSource,
      l.sectionConfidence,
    ]);
    const placeLink = hookFor(answers)({
      document: parseDocument(page(body)),
      url: URL,
      html: page(body),
    })!.placeLink;
    const extracted = extractLinks(parseDocument(page(body)), URL, placeLink).map((l) => [
      l.text,
      l.section,
      l.sectionSource,
      l.sectionConfidence,
    ]);
    expect(extracted).toEqual(stored);
  });
});
