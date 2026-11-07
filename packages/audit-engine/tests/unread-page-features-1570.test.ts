// #1570: an unread page (audited as an empty document) has no word count and no page type in page_features, so
// content/thin-vs-site-norm leaves it out of the site norm instead of counting a zero-word page.

import { describe, expect, test } from "bun:test";
import { parsePage } from "@squirrelscan/parser";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { extractPageFeatures } from "../src/page-features";
import { ORIGIN, mkPage } from "./helpers/template-corpus";

const URL_ = `${ORIGIN}/x`;
const HTML = `<!doctype html><html lang="en"><head><title>A page with words</title></head><body><main><h1>Words</h1><p>${"word ".repeat(300)}</p></main></body></html>`;

describe("page features of an unread page (#1570)", () => {
  test("wordCount and pageType are null, not zero", () => {
    const page = mkPage(URL_, HTML) as PageRecord;
    const read = parsePage(HTML, URL_);
    const unread = { ...parsePage("<html><head></head><body></body></html>", URL_), parseNotices: ["the page could not be read (boom), so it was audited empty"] };
    expect(extractPageFeatures(page, read).wordCount).toBeGreaterThan(100);
    const row = extractPageFeatures(page, unread);
    expect(row.wordCount).toBeNull();
    expect(row.pageType).toBeNull();
  });

  test("a cut class attribute is not an unread page", () => {
    const page = mkPage(URL_, HTML) as PageRecord;
    const cut = { ...parsePage(HTML, URL_), parseNotices: ["a class attribute of 640,000 tokens was cut to the first 20,000 to read the page"] };
    expect(extractPageFeatures(page, cut).wordCount).toBeGreaterThan(100);
  });
});
