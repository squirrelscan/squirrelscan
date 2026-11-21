// The stored navigation link set is the one links/nav-set-divergence's legacy path derives, so
// the streaming rule and the legacy rule compare the same sets.

import type { PageRecord } from "@squirrelscan/core-contracts";

import { parsePage } from "@squirrelscan/parser";
import { pageNavLinkSet } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import { extractPageFeatures } from "../src/index";

const URL_ = "https://example.com/a";
const record = {
  url: URL_,
  normalizedUrl: URL_,
  finalUrl: URL_,
  depth: 1,
  status: 200,
  sizeBytes: 1,
  headers: {},
  securityHeaders: {},
} as unknown as PageRecord;

describe("extractPageFeatures: navLinkSet", () => {
  test("equals pageNavLinkSet for the page's own URL", () => {
    const html = `<html><body><header><a href="/a">a</a><a href="/b#top">b</a></header><footer><a href="/c">c</a></footer></body></html>`;
    const parsed = parsePage(html, URL_);
    const set = extractPageFeatures(record, parsed).navLinkSet;
    expect(set).toEqual(pageNavLinkSet(parsed, URL_));
    expect(set?.hrefs).toEqual([
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  test("is null for a page with no chrome links", () => {
    const parsed = parsePage(
      '<html><body><p>Hello <a href="/x">x</a></p></body></html>',
      URL_
    );
    expect(extractPageFeatures(record, parsed).navLinkSet).toBeNull();
  });
});
