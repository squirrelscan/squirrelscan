// repo#1082: every output format names a rule-filtered run; an unfiltered run carries no marker.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";

import { partialAuditLine } from "../src/coverage";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";

function report(extra: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 1,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {
      "perf/lcp": {
        meta: {
          id: "perf/lcp",
          name: "LCP",
          description: "d",
          category: "perf",
          scope: "page",
          severity: "warning",
          weight: 5,
        },
        checks: [
          {
            name: "c",
            status: "pass",
            message: "m",
            pageUrl: "https://example.com/",
          },
        ],
      },
    },
    ...extra,
  } as unknown as AuditReport;
}

const partial = {
  include: ["perf/*"],
  exclude: [],
  includedCategories: ["perf"],
};

const renderers: Array<[string, (r: AuditReport) => string]> = [
  ["json", (r) => renderJson(r)],
  ["text", (r) => renderText(r)],
  ["markdown", (r) => renderMarkdown(r)],
  ["xml", (r) => renderXml(r)],
  ["llm", (r) => renderLlm(r)],
];

describe("partial-audit marker per format (repo#1082)", () => {
  for (const [name, render] of renderers) {
    test(`${name} names the included category on a filtered run`, () => {
      const out = render(report({ partialAudit: partial }));
      if (name === "json") {
        expect(JSON.parse(out).meta.partialAudit.includedCategories).toEqual([
          "perf",
        ]);
      } else if (name === "xml" || name === "llm") {
        expect(out).toContain('included-categories="perf"');
      } else {
        expect(out).toContain(partialAuditLine({ partialAudit: partial })!);
      }
    });

    test(`${name} carries no marker on an unfiltered run`, () => {
      const out = render(report());
      if (name === "json") {
        expect("partialAudit" in JSON.parse(out).meta).toBe(false);
      } else {
        expect(out).not.toContain("partial");
        expect(out).not.toMatch(/partial[- ]audit/i);
      }
    });
  }

  test("an empty filter (no include, exclude or level) is not partial", () => {
    expect(
      partialAuditLine({
        partialAudit: { include: [], exclude: [], includedCategories: [] },
      })
    ).toBeNull();
  });
});
