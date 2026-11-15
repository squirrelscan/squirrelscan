import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderJson } from "../src/output/json";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 5,
    passed: 10,
    warnings: 1,
    failed: 2,
    ruleResults: {},
    ...over,
  };
}

const note = {
  noCache: true,
  freshRender: true,
  stalePageCount: 1,
  stalePages: [{ url: "https://example.com/a", signal: "Age: 90" }],
};

describe("report cacheFreshness (#2032)", () => {
  test("absent on an ordinary audit in every format", () => {
    expect("cacheFreshness" in JSON.parse(renderJson(report()))).toBe(false);
    expect(renderText(report())).not.toContain("no-cache");
    expect(renderMarkdown(report())).not.toContain("no-cache");
  });
  test("json carries the note", () => {
    expect(JSON.parse(renderJson(report({ cacheFreshness: note }))).cacheFreshness).toEqual(note);
  });
  test("text and markdown name the stale page and the fresh render", () => {
    for (const out of [
      renderText(report({ cacheFreshness: note })),
      renderMarkdown(report({ cacheFreshness: note })),
    ]) {
      expect(out).toContain("Cache-Control: no-cache");
      expect(out).toContain("https://example.com/a");
      expect(out).toContain("Age: 90");
      expect(out).toContain("rendered fresh, without the render cache");
    }
  });
  test("a clean no-cache crawl says no page looked cached", () => {
    const out = renderText(
      report({
        cacheFreshness: { noCache: true, freshRender: false, stalePageCount: 0, stalePages: [] },
      }),
    );
    expect(out).toContain("No page response looked cached.");
    expect(out).not.toContain("rendered fresh");
  });
});
