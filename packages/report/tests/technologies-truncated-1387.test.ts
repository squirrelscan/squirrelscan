// #1387: a technologies section that a byte cap or the time budget cut short says so in
// every report format, and one that read everything says nothing.

import { describe, expect, test } from "bun:test";

import { techChangeSummary, techTruncationNote } from "../src/technologies";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

const item = { id: "wordpress", name: "WordPress", category: "cms", version: null, confidence: "high", detectedBy: "meta:generator" };
const section = (over: object) => ({ items: [item], added: [], removed: [], firstScan: false, source: "local", ...over });
const cut = { reasons: ["bundle-bytes", "time-budget"], scripts: 2 };

function report(technologies: object): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T10:00:00.000Z",
    totalPages: 1,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    technologies,
  } as unknown as AuditReport;
}

describe("technologies truncated (#1387)", () => {
  test("the note names every reason; none when the scan read everything", () => {
    const note = techTruncationNote(section({ truncated: cut }) as never);
    expect(note).toContain("cut short");
    expect(note).toContain("bundle_bytes");
    expect(note).toContain("time budget");
    expect(techTruncationNote(section({}) as never)).toBeNull();
  });

  test("the summary line carries the note beside the origin", () => {
    const line = techChangeSummary(section({ truncated: cut }) as never);
    expect(line).toContain("Detected locally from the crawled pages");
    expect(line).toContain("Detection was cut short");
    expect(techChangeSummary(section({}) as never)).not.toContain("cut short");
  });

  test("the text and markdown reports say so", () => {
    const r = report(section({ truncated: cut }));
    expect(String(renderText(r as never))).toContain("Detection was cut short");
    expect(String(renderMarkdown(r as never))).toContain("Detection was cut short");
    expect(String(renderText(report(section({})) as never))).not.toContain("cut short");
  });

  test("the JSON report carries truncated with the reasons", () => {
    const json = JSON.parse(renderJson(report(section({ truncated: cut })) as never) as string) as {
      technologies?: { truncated?: { reasons: string[]; scripts: number } };
    };
    expect(json.technologies?.truncated).toEqual(cut);
    const clean = JSON.parse(renderJson(report(section({})) as never) as string) as { technologies?: { truncated?: unknown } };
    expect(clean.technologies?.truncated).toBeUndefined();
  });

  test("the llm and xml reports carry a truncated attribute", () => {
    for (const out of [String(renderLlm(report(section({ truncated: cut })) as never)), String(renderXml(report(section({ truncated: cut })) as never))]) {
      expect(out).toContain('<technologies source="local" truncated="bundle-bytes time-budget">');
    }
    expect(String(renderLlm(report(section({})) as never))).not.toContain("truncated=");
  });
});
