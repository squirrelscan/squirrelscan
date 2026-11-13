// The stored reading level is the number content/reading-level reports, so the streaming
// rule (content/voice-consistency) and the legacy path read the same score.

import { describe, expect, test } from "bun:test";

import { parsePage } from "@squirrelscan/parser";
import { pageReadingLevel } from "@squirrelscan/rules";
import type { PageRecord } from "@squirrelscan/core-contracts";

import { extractPageFeatures } from "../src/index";

const URL_ = "https://example.com/a";
const record = { url: URL_, normalizedUrl: URL_, finalUrl: URL_, depth: 1, status: 200, sizeBytes: 1, headers: {}, securityHeaders: {} } as unknown as PageRecord;

describe("extractPageFeatures: readingLevel", () => {
  test("equals content/reading-level's score for a page with enough text", () => {
    const text = "Every customer receives careful support during the first week of service. ".repeat(12);
    const parsed = parsePage(`<html><body><main><p>${text}</p></main></body></html>`, URL_);
    const level = extractPageFeatures(record, parsed).readingLevel;
    expect(level).toBe(pageReadingLevel(parsed));
    expect(level).toBe(34);
  });

  test("is null for a page too short to score", () => {
    const parsed = parsePage("<html><body><p>Hello there.</p></body></html>", URL_);
    expect(extractPageFeatures(record, parsed).readingLevel).toBeNull();
  });
});
