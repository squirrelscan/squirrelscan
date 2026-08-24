// LinkData.isChrome — did the anchor sit in sitewide chrome? (#109)
//
// Two producers must agree, because the two rule paths read different ones:
// `parsePage` (html.ts) is what the crawler SERIALIZES into `parsedData`, which
// both `site.pages` and `createSiteQuery` re-read, while `extractLinks`
// (extractors/links.ts) is what `parseHtmlForRules` uses. A flag set by only one
// of them is silently absent wherever it matters, so both are covered here.

import { describe, expect, test } from "bun:test";

import { extractLinks } from "../src/extractors/links";
import { parsePage } from "../src/html";
import { parseDocument } from "../src/index";

const URL = "https://example.com/post";

function page(body: string): string {
  return `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
}

/** `isChrome` by link text, from the parsePage (stored-parsedData) producer. */
function chromeByText(body: string): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  for (const l of parsePage(page(body), URL).links) out[l.text] = l.isChrome;
  return out;
}

describe("parsePage — isChrome", () => {
  test("nav, header, footer and aside anchors are chrome; body copy is not", () => {
    expect(
      chromeByText(
        `<header><a href="/h">h</a></header>` +
          `<nav><a href="/n">n</a></nav>` +
          `<aside><a href="/s">s</a></aside>` +
          `<footer><a href="/f">f</a></footer>` +
          `<main><p><a href="/c">c</a></p></main>`,
      ),
    ).toEqual({ h: true, n: true, s: true, f: true, c: false });
  });

  test("a wrapper nested inside a landmark is still chrome", () => {
    // The whole subtree of a landmark is chrome — a content-ish wrapper inside
    // the footer does not make a sitewide link editorial.
    expect(chromeByText(`<footer><div class="content"><a href="/f">f</a></div></footer>`)).toEqual({
      f: true,
    });
  });

  test("class/id names alone are NOT chrome", () => {
    // Deliberately stricter than `detectLinkPosition`'s class/id heuristics: a
    // post wrapper called "nav" must not silently reclassify body links.
    expect(
      chromeByText(
        `<div class="post-nav"><a href="/a">a</a></div>` +
          `<div id="sidebar"><a href="/b">b</a></div>`,
      ),
    ).toEqual({ a: false, b: false });
  });

  test("a page with no landmarks at all marks every link contextual", () => {
    expect(chromeByText(`<p><a href="/a">a</a></p><div><a href="/b">b</a></div>`)).toEqual({
      a: false,
      b: false,
    });
  });
});

describe("extractLinks — isChrome agrees with parsePage", () => {
  test("same classification, and `position` is unchanged by it", () => {
    const body =
      `<header><nav><a href="/n">n</a></nav></header>` +
      `<main><p><a href="/c">c</a></p></main>` +
      `<div class="post-nav"><a href="/a">a</a></div>`;
    const links = extractLinks(parseDocument(page(body)), URL);

    expect(links.map((l) => [l.text, l.isChrome])).toEqual([
      ["n", true],
      ["c", false],
      ["a", false],
    ]);
    // The looser `position` label keeps its previous behaviour: it resolves on
    // the *closest* ancestor, so the `<header><nav>` link is "nav" rather than
    // "header", and class/id heuristics still apply (`post-nav` → "nav"). That
    // looseness is exactly why isChrome is a separate, landmark-strict signal.
    expect(links.map((l) => l.position)).toEqual(["nav", "content", "nav"]);
  });
});
