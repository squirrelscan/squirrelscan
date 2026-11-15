// The stored simhash is the number content/near-duplicate derives inline on its legacy path
// (same exported function), so the streaming and legacy answers agree.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { pageContentSimhash } from "@squirrelscan/rules";
import type { PageRecord } from "@squirrelscan/core-contracts";

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

const prose = Array.from(
  { length: 150 },
  (_, i) => `word${i % 37} thing${i % 11} place${i % 53}`,
).join(" ");

describe("extractPageFeatures: contentSimhash", () => {
  test("equals pageContentSimhash for a page with enough main text", () => {
    const parsed = parsePage(
      `<html><body><nav>menu links</nav><main><p>${prose}</p></main><footer>foot</footer></body></html>`,
      URL_,
    );
    const hash = extractPageFeatures(record, parsed).contentSimhash;
    expect(hash).toBe(pageContentSimhash(parsed.document, URL_, URL_));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is null for a page too short to hash", () => {
    const parsed = parsePage("<html><body><p>Hello there.</p></body></html>", URL_);
    expect(extractPageFeatures(record, parsed).contentSimhash).toBeNull();
  });

  test("is null for a redirected page", () => {
    const parsed = parsePage(`<html><body><main><p>${prose}</p></main></body></html>`, URL_);
    const redirected = { ...record, finalUrl: "https://example.com/elsewhere" } as PageRecord;
    expect(extractPageFeatures(redirected, parsed).contentSimhash).toBeNull();
  });
});
