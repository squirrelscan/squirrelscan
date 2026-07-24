// #512 — render-block recovery note. When pages were blocked at the browser/
// cloud render and recovered via a non-browser fallback fetch, the report shows
// an informational line in the text + markdown outputs.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { fetchFallbacksLine } from "../src/coverage";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("fetchFallbacksLine (#512)", () => {
  test("null when nothing recovered / field absent", () => {
    expect(fetchFallbacksLine(baseReport())).toBeNull();
    expect(fetchFallbacksLine(baseReport({ fetchFallbacks: { recovered: 0 } }))).toBeNull();
  });

  test("pluralizes the recovered count", () => {
    expect(fetchFallbacksLine(baseReport({ fetchFallbacks: { recovered: 1 } }))).toBe(
      "1 page recovered via direct fetch after a render block."
    );
    expect(fetchFallbacksLine(baseReport({ fetchFallbacks: { recovered: 3 } }))).toBe(
      "3 pages recovered via direct fetch after a render block."
    );
  });

  test("text + markdown outputs surface the note only when recovered > 0", () => {
    const withNote = baseReport({ fetchFallbacks: { recovered: 2 } });
    const note = "2 pages recovered via direct fetch after a render block.";
    expect(renderText(withNote)).toContain(note);
    expect(renderMarkdown(withNote)).toContain(note);

    expect(renderText(baseReport())).not.toContain("recovered via direct fetch");
    expect(renderMarkdown(baseReport())).not.toContain("recovered via direct fetch");
  });
});
