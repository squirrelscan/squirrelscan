// squirrelscan/repo#3397: every format says how much JavaScript the audit
// measured, and says nothing when it measured none.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import {
  javascriptHeaviestPagesLine,
  javascriptShippedLine,
  javascriptXml,
} from "../src/javascript-shipped";
import { renderText } from "../src/output/text";
import { renderMarkdown } from "../src/output/markdown";
import { renderHtml } from "../src/output/html";
import { renderLlm } from "../src/output/llm";
import { renderXml } from "../src/output/xml";
import { renderJson } from "../src/output/json";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-27T14:30:00.000Z",
    totalPages: 3,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

const JAVASCRIPT: NonNullable<AuditReport["javascript"]> = {
  scripts: 34,
  bytes: 1_258_291,
  thirdPartyBytes: 215_040,
  unmeasured: 2,
  framework: { id: "nextjs", name: "Next.js", bytes: 655_360 },
  heaviestPages: [
    { url: "https://example.com/blog/post", bytes: 1_003_520, scripts: 12 },
    { url: "https://example.com/", bytes: 890_880, scripts: 10 },
  ],
};

const withJs = baseReport({ javascript: JAVASCRIPT });

const SUMMARY =
  "1.2 MB across 34 scripts (Next.js runtime 640.0 KB, 52%; third-party 210.0 KB; 2 not measured)";

describe("javascript shipped lines", () => {
  test("one summary line and the heaviest pages", () => {
    expect(javascriptShippedLine(withJs)).toBe(`JavaScript shipped: ${SUMMARY}`);
    expect(javascriptHeaviestPagesLine(withJs)).toBe(
      "Heaviest pages by script: https://example.com/blog/post (980.0 KB, 12 scripts), https://example.com/ (870.0 KB, 10 scripts)",
    );
  });

  test("details are left out when there are none", () => {
    const plain = baseReport({
      javascript: { scripts: 1, bytes: 2048, thirdPartyBytes: 0, unmeasured: 0, heaviestPages: [] },
    });
    expect(javascriptShippedLine(plain)).toBe("JavaScript shipped: 2.0 KB across 1 script");
    expect(javascriptHeaviestPagesLine(plain)).toBeNull();
  });

  test("no block, or an empty one, is no line", () => {
    const empty = baseReport({
      javascript: { scripts: 0, bytes: 0, thirdPartyBytes: 0, unmeasured: 3, heaviestPages: [] },
    });
    for (const report of [baseReport(), empty]) {
      expect(javascriptShippedLine(report)).toBeNull();
      expect(javascriptHeaviestPagesLine(report)).toBeNull();
      expect(javascriptXml(report, 0)).toEqual([]);
    }
  });
});

describe("every format carries it", () => {
  test("text", () => {
    const out = renderText(withJs);
    expect(out).toContain(`JavaScript shipped: ${SUMMARY}`);
    expect(out).toContain("Heaviest pages by script: https://example.com/blog/post");
  });

  test("markdown", () => {
    const out = renderMarkdown(withJs);
    expect(out).toContain("- **JavaScript shipped:** 1.2 MB across 34 scripts");
    expect(out).toContain("- **Heaviest pages by script:**");
  });

  test("html", () => {
    const out = renderHtml(withJs, { reportId: "TESTID" });
    expect(out).toContain("JavaScript shipped");
    expect(out).toContain("1.2 MB across 34 scripts");
    expect(out).toContain("https://example.com/blog/post");
  });

  test("llm and xml", () => {
    const element =
      '<javascript bytes="1258291" scripts="34" third-party-bytes="215040" unmeasured="2" framework="nextjs" framework-bytes="655360">';
    expect(renderLlm(withJs)).toContain(element);
    expect(renderLlm(withJs)).toContain(
      '<page url="https://example.com/blog/post" bytes="1003520" scripts="12"/>',
    );
    expect(renderXml(withJs)).toContain(`    ${element}`);
  });

  test("json", () => {
    const out = JSON.parse(renderJson(withJs));
    expect(out.javascript).toEqual(JAVASCRIPT);
  });

  test("and none of them mentions it without a block", () => {
    const report = baseReport();
    expect(renderText(report)).not.toContain("JavaScript shipped");
    expect(renderMarkdown(report)).not.toContain("JavaScript shipped");
    expect(renderHtml(report, { reportId: "TESTID" })).not.toContain("JavaScript shipped");
    expect(renderLlm(report)).not.toContain("<javascript");
    expect(renderXml(report)).not.toContain("<javascript");
    expect(JSON.parse(renderJson(report))).not.toHaveProperty("javascript");
  });
});

describe("a report read back from JSON is escaped", () => {
  const hostile = baseReport({
    javascript: {
      ...JAVASCRIPT,
      framework: { id: 'x"><script>', name: "<b>Evil</b>", bytes: 1 },
      heaviestPages: [{ url: 'https://example.com/"><script>alert(1)</script>', bytes: 10, scripts: 1 }],
    },
  });

  test("html, llm, xml and markdown", () => {
    expect(renderHtml(hostile, { reportId: "TESTID" })).not.toContain("<script>alert(1)");
    expect(renderHtml(hostile, { reportId: "TESTID" })).not.toContain("<b>Evil</b>");
    for (const out of [renderLlm(hostile), renderXml(hostile)]) {
      expect(out).not.toContain('"><script>');
      expect(out).toContain("&quot;&gt;&lt;script&gt;");
    }
    expect(renderMarkdown(hostile)).not.toContain("<script>alert(1)</script>");
  });
});
