// #1263: a technologies section says where it came from. A local scan keeps no history, so it
// never claims "no changes since last scan" or "first scan"; a cloud scan keeps both.

import { describe, expect, test } from "bun:test";

import { techChangeSummary } from "../src/technologies";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import { renderXml } from "../src/output/xml";
import type { AuditReport } from "../src/types";

const item = {
  id: "wordpress",
  name: "WordPress",
  category: "cms",
  version: null,
  confidence: "high",
  detectedBy: "meta:generator",
};
const section = (over: object) => ({
  items: [item],
  added: [],
  removed: [],
  firstScan: false,
  ...over,
});

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

describe("technologies source (#1263)", () => {
  test("a local section names its origin instead of a scan diff", () => {
    for (const firstScan of [true, false]) {
      expect(techChangeSummary(section({ source: "local", firstScan }) as never)).toBe(
        "Detected locally from the crawled pages (no scan history)",
      );
    }
  });

  test("a cloud section, and one with no source, keep the diff wording", () => {
    expect(techChangeSummary(section({ source: "cloud" }) as never)).toBe(
      "No changes since last scan",
    );
    expect(techChangeSummary(section({ source: "cloud", firstScan: true }) as never)).toBe(
      "First recorded scan of this domain",
    );
    expect(techChangeSummary(section({}) as never)).toBe("No changes since last scan");
  });

  test("the text, markdown and JSON reports carry it", () => {
    const local = report(section({ source: "local" }));
    expect(String(renderText(local as never))).toContain("Detected locally from the crawled pages");
    expect(String(renderMarkdown(local as never))).toContain(
      "Detected locally from the crawled pages",
    );
    const json = JSON.parse(renderJson(local as never) as string) as {
      technologies?: { source?: string };
    };
    expect(json.technologies?.source).toBe("local");
    const cloud = JSON.parse(
      renderJson(report(section({ source: "cloud" })) as never) as string,
    ) as {
      technologies?: { source?: string };
    };
    expect(cloud.technologies?.source).toBe("cloud");
    const legacy = JSON.parse(renderJson(report(section({})) as never) as string) as {
      technologies?: { source?: string };
    };
    expect(legacy.technologies?.source).toBeUndefined();
  });

  test("the llm and xml reports name the source and make no diff claim for a local section", () => {
    for (const out of [
      String(renderLlm(report(section({ source: "local" })) as never)),
      String(renderXml(report(section({ source: "local" })) as never)),
    ]) {
      expect(out).toContain('<technologies source="local">');
      expect(out).not.toContain("first-scan");
      expect(out).not.toContain('added="');
    }
  });

  test("the llm and xml reports keep the diff attributes for a cloud section, and for one with no source", () => {
    for (const make of [() => section({ source: "cloud" }), () => section({})]) {
      for (const out of [
        String(renderLlm(report(make()) as never)),
        String(renderXml(report(make()) as never)),
      ]) {
        expect(out).toContain('first-scan="false" added="0" removed="0"');
      }
    }
    expect(String(renderLlm(report(section({ source: "cloud" })) as never))).toContain(
      'source="cloud"',
    );
    expect(String(renderXml(report(section({})) as never))).not.toContain("source=");
  });
});
