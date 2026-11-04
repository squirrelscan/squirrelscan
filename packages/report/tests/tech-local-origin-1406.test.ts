import { describe, expect, test } from "bun:test";

import type { ReportTechnologies } from "@squirrelscan/core-contracts";

import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import { techChangeSummary, techLocalOnlyNote } from "../src/technologies";
import type { AuditReport } from "../src/types";

const base = { added: [], removed: [], firstScan: false };
const item = (id: string, origin?: "local") => ({
  id,
  name: id,
  category: "framework" as const,
  version: null,
  confidence: "high" as const,
  detectedBy: "t",
  ...(origin ? { origin } : {}),
});

describe("technologies found only by the local scan, in a cloud section (#1406)", () => {
  const merged: ReportTechnologies = { ...base, source: "cloud", items: [item("react"), item("svelte", "local"), item("vue", "local")] };

  test("the summary says how many have no scan history", () => {
    expect(techLocalOnlyNote(merged)).toBe("2 found only by the local scan of the crawled bundles (no scan history)");
    expect(techChangeSummary(merged)).toContain("No changes since last scan");
    expect(techChangeSummary(merged)).toContain("2 found only by the local scan");
  });

  test("no note for a local section or when every item came from the cloud", () => {
    expect(techLocalOnlyNote({ ...merged, source: "local" })).toBeNull();
    expect(techLocalOnlyNote({ ...base, source: "cloud", items: [item("react")] })).toBeNull();
  });
});

function report(items: object[]): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-30T10:00:00.000Z",
    totalPages: 1,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    technologies: { ...base, source: "cloud", items },
  } as unknown as AuditReport;
}

describe("every human-readable format marks a local-only technology (#1406)", () => {
  const r = report([
    item("react"),
    { ...item("vue"), name: "Vue", origin: "local" },
  ]);

  test("text", () => {
    const out = String(renderText(r as never));
    expect(out).toContain("Vue (local scan)");
    expect(out).not.toContain("react (local scan)");
  });

  test("markdown", () => {
    const out = String(renderMarkdown(r as never));
    expect(out).toContain("Vue (local scan)");
    expect(out).not.toContain("react (local scan)");
  });

  test("html", () => {
    const out = String(renderHtml(r as never));
    expect(out).toMatch(/Vue[\s\S]{0,200}local scan/);
    expect(out).not.toMatch(/react[^<]*<[^>]*>[^<]*local scan/);
  });

  test("llm and xml keep the machine attribute", () => {
    expect(String(renderLlm(r as never))).toContain('origin="local"');
    expect(String(renderXml(r as never))).toContain('origin="local"');
  });
});

describe("a hostile origin in a loaded report is never emitted (#1406)", () => {
  const hostile = 'local"/><injected/><!--';
  const r = report([{ ...item("vue"), origin: hostile }, { ...item("react"), origin: "cloud" }]);

  test("xml and llm emit no origin attribute and no injected element", () => {
    for (const out of [String(renderXml(r as never)), String(renderLlm(r as never))]) {
      expect(out).not.toContain("<injected");
      expect(out).not.toContain("origin=");
      expect(out).not.toContain("<!--");
    }
  });

  test("text, markdown, html, json treat it as not local", () => {
    for (const out of [
      String(renderText(r as never)),
      String(renderMarkdown(r as never)),
      String(renderHtml(r as never)),
    ]) {
      expect(out).not.toContain("local scan)");
      expect(out).not.toContain("<injected");
    }
    const json = JSON.parse(String(renderJson(r as never))) as {
      technologies: { items: { origin?: string }[] };
    };
    expect(json.technologies.items.every((t) => t.origin === undefined)).toBe(true);
    expect(techLocalOnlyNote(r.technologies as never)).toBeNull();
  });
});

describe("a hostile source, truncated reason or first-scan in a loaded report is never emitted (#1406)", () => {
  const evil = 'x"/><injected/><!--';
  const loaded = (over: object): AuditReport =>
    ({
      ...report([item("react")]),
      technologies: { ...base, items: [item("react")], ...over },
    }) as unknown as AuditReport;

  test("xml and llm open tags carry only closed-set values", () => {
    for (const over of [
      { source: evil },
      { source: "local", truncated: { reasons: [evil, "script-limit"], scripts: 1 } },
      { source: "cloud", firstScan: evil },
    ]) {
      for (const out of [String(renderXml(loaded(over))), String(renderLlm(loaded(over)))]) {
        expect(out).not.toContain("<injected");
        expect(out).not.toContain("<!--");
      }
    }
  });

  test("valid values are kept, hostile reasons dropped", () => {
    const out = String(
      renderXml(loaded({ source: "local", truncated: { reasons: [evil, "script-limit"], scripts: 1 } })),
    );
    expect(out).toContain('<technologies source="local" truncated="script-limit">');
    const llm = String(renderLlm(loaded({ source: "cloud", firstScan: evil, truncated: undefined })));
    expect(llm).toContain('<technologies source="cloud" first-scan="false"');
    expect(String(renderLlm(loaded({ source: evil })))).toContain('<technologies first-scan="false"');
  });

  test("the summary note ignores a reason outside the set", () => {
    const note = techChangeSummary(
      loaded({ source: "local", truncated: { reasons: [evil], scripts: 1 } }).technologies as never,
    );
    expect(note).not.toContain("undefined");
    expect(note).not.toContain("<injected");
  });
});
