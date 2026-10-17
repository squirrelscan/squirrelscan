// pub#866: html, markdown and text said how many items a check left out
// (#854). llm dropped the count when a check kept no items, console counted
// only the items past its own preview, and xml listed the kept items alone.
// Every format now gives the same number for the same finding.

import {
  renderHtml,
  renderJson,
  renderLlm,
  renderMarkdown,
  renderText,
  renderXml,
} from "@squirrelscan/report";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import { generateConsoleReport } from "../../src/reports/output/console";

/** One failing check that lists `listed` items and left `leftOut` out. */
function report(listed: number, leftOut: number): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-18T00:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 1,
    ruleResults: {
      "images/alt": {
        meta: {
          id: "images/alt",
          name: "Image alt text",
          description: "desc",
          solution: "sol",
          category: "images",
          scope: "page",
          severity: "error",
          weight: 10,
        },
        checks: [
          {
            name: "missing-alt",
            status: "fail",
            message: "Image is missing alt text",
            pages: ["https://example.com/"],
            items: Array.from({ length: listed }, (_, i) => ({
              id: `/images/i${i}.png`,
            })),
            details: { additional: leftOut },
          },
        ],
      },
    },
    healthScore: {
      overall: 60,
      categories: [],
      groups: [],
      errorCount: 1,
      warningCount: 0,
      passedCount: 0,
    },
  } as unknown as AuditReport;
}

function consoleText(r: AuditReport): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    generateConsoleReport(r);
  } finally {
    console.log = original;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const num = (s: string | undefined) => Number((s ?? "NaN").replace(/,/g, ""));

/** The left-out count each format gives for the one check. */
function leftOutByFormat(
  r: AuditReport,
  listed: number
): Record<string, number> {
  const html = renderHtml(r);
  const markdown = renderMarkdown(r);
  const text = renderText(r);
  const llm = renderLlm(r);
  const xml = renderXml(r);
  const json = JSON.parse(renderJson(r));
  const cons = consoleText(r);
  const pick = (out: string, listedRe: RegExp, noneRe: RegExp) =>
    num((listed > 0 ? listedRe : noneRe).exec(out)?.[1]);
  return {
    html: pick(
      html,
      /items?, ([\d,]+) more not listed/,
      /([\d,]+) items? not listed/
    ),
    markdown: pick(
      markdown,
      /item\(s\), ([\d,]+) more not listed/,
      /([\d,]+) items? not listed/
    ),
    text: pick(
      text,
      /\.\.\. and ([\d,]+) more items not listed/,
      /([\d,]+) items? not listed/
    ),
    console: pick(cons, /\.\.\. \+([\d,]+) more/, /([\d,]+) items? not listed/),
    llm: (() => {
      const m = /Items \((\d+)\/(\d+)\)/.exec(llm);
      return m ? num(m[2]) - num(m[1]) : Number.NaN;
    })(),
    xml: num(/<items count="\d+" not-listed="(\d+)"/.exec(xml)?.[1]),
    json: json.issues?.[0]?.checks?.[0]?.details?.additional ?? Number.NaN,
  };
}

describe("every format gives the same left-out count (pub#866)", () => {
  test("a check that lists 2 items and left 1,145 out", () => {
    const counts = leftOutByFormat(report(2, 1_145), 2);
    expect(counts).toEqual({
      html: 1_145,
      markdown: 1_145,
      text: 1_145,
      console: 1_145,
      llm: 1_145,
      xml: 1_145,
      json: 1_145,
    });
  });

  test("a check that lists none and left 1,500 out", () => {
    const counts = leftOutByFormat(report(0, 1_500), 0);
    expect(counts).toEqual({
      html: 1_500,
      markdown: 1_500,
      text: 1_500,
      console: 1_500,
      llm: 1_500,
      xml: 1_500,
      json: 1_500,
    });
    expect(renderLlm(report(0, 1_500))).toContain(
      "Items (0/1500): none listed"
    );
    expect(renderXml(report(0, 1_500))).toContain(
      '<items count="0" not-listed="1500"/>'
    );
  });

  test("console adds the left-out items to those past its preview", () => {
    expect(consoleText(report(7, 10))).toContain("... +12 more");
  });

  test("thousands are grouped in the console count", () => {
    expect(consoleText(report(2, 1_145))).toContain("... +1,145 more");
  });

  test("llm totals a rule's checks, one listing items and one listing none", () => {
    const r = report(2, 3);
    const rule = r.ruleResults["images/alt"]!;
    rule.checks.push({
      ...rule.checks[0]!,
      name: "missing-alt-counts",
      items: [],
      details: { additional: 5 },
    });
    expect(renderLlm(r)).toContain("Items (2/10):");
    const cons = consoleText(r);
    expect(cons).toContain("... +3 more");
    expect(cons).toContain("5 items not listed");
  });

  test("nothing left out says nothing more", () => {
    const r = report(3, 0);
    expect(renderXml(r)).not.toContain("not-listed");
    expect(consoleText(r)).not.toContain("more");
    expect(consoleText(r)).not.toContain("not listed");
    expect(renderLlm(r)).toContain("Items (3):");
  });
});
