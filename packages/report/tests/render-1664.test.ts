// The render block in the JSON and LLM reports (#1664).

import { describe, expect, test } from "bun:test";

import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import type { AuditReport } from "../src/types";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-11-10T10:00:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const fellBack = {
  requested: true,
  mode: "all" as const,
  fallbackReason: "out of credits",
  pagesRendered: 12,
  pagesFetchedPlain: 28,
};
const clean = { requested: true, mode: "all" as const, pagesRendered: 40, pagesFetchedPlain: 0 };

describe("render in the JSON report", () => {
  test("carries the mode, the page split and the fallback reason", () => {
    expect(JSON.parse(renderJson(report({ render: fellBack }))).render).toEqual(fellBack);
  });

  test("a render that ran to the end has no fallbackReason", () => {
    const parsed = JSON.parse(renderJson(report({ render: clean })));
    expect(parsed.render).toEqual(clean);
    expect("fallbackReason" in parsed.render).toBe(false);
  });

  test("a report with no render block (read back from the store) has no render field", () => {
    expect("render" in JSON.parse(renderJson(report()))).toBe(false);
  });
});

describe("render in the LLM report", () => {
  const llm = (r: AuditReport) =>
    renderLlm(r as Parameters<typeof renderLlm>[0], { version: "0.0.0", includePassed: false, includeInfo: false });

  test("a <render> element with the mode, the split and the reason", () => {
    expect(llm(report({ render: fellBack }))).toContain(
      '<render requested="true" mode="all" pages-rendered="12" pages-fetched-plain="28" fallback-reason="out of credits"/>',
    );
  });

  test("no fallback, no reason attribute", () => {
    expect(llm(report({ render: clean }))).toContain(
      '<render requested="true" mode="all" pages-rendered="40" pages-fetched-plain="0"/>',
    );
  });

  test("the reason is escaped", () => {
    expect(llm(report({ render: { ...fellBack, fallbackReason: 'a"b<c' } }))).toContain(
      'fallback-reason="a&quot;b&lt;c"',
    );
  });

  test("no render block, no element", () => {
    expect(llm(report())).not.toContain("<render ");
  });
});
