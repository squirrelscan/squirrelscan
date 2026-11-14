// #1782: every report says whether robots.txt was honoured and how many pages it kept out of the audit.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { robotsHonouredNote, robotsScope } from "../src/coverage";
import { renderHtml } from "../src/output/html";
import { renderJson } from "../src/output/json";
import { renderLlm } from "../src/output/llm";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";

const report = (scope: Record<string, unknown>): AuditReport =>
  ({
    baseUrl: "https://example.com",
    timestamp: "2026-11-12T00:00:00.000Z",
    totalPages: 2,
    passed: 1,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    scanScope: { origin: "cli", maxPages: 50, pagesCrawled: 2, capped: false, ...scope },
  }) as unknown as AuditReport;

const NOT_HONOURED = "robots.txt was not honoured";
const HONOURED = "robots.txt was honoured: 7 pages it disallows were left out of the audit";

describe("robotsHonouredNote", () => {
  test("respect_robots = false says robots.txt was not honoured", () => {
    const note = robotsHonouredNote(report({ respectRobots: false, robotsBlockedPages: 0 }));
    expect(note).toContain(NOT_HONOURED);
  });

  test("a site that disallows /private/ reports the skipped count", () => {
    expect(robotsHonouredNote(report({ respectRobots: true, robotsBlockedPages: 7 }))).toContain(HONOURED);
    expect(robotsHonouredNote(report({ respectRobots: true, robotsBlockedPages: 1 }))).toContain(
      "1 page it disallows was left out",
    );
  });

  test("honoured with nothing skipped says it kept no pages out", () => {
    expect(robotsHonouredNote(report({ respectRobots: true, robotsBlockedPages: 0 }))).toContain("kept no pages out");
  });

  test("a report from before the field says nothing, and junk values are not trusted", () => {
    expect(robotsHonouredNote(report({}))).toBeNull();
    expect(robotsScope(report({ respectRobots: "yes" }))).toBeNull();
    expect(robotsScope(report({ respectRobots: true, robotsBlockedPages: -3 }))?.robotsBlockedPages).toBe(0);
    expect(robotsScope(report({ respectRobots: false, robotsBlockedPages: 9 }))?.robotsBlockedPages).toBe(0);
  });
});

describe("renderers", () => {
  const honoured = report({ respectRobots: true, robotsBlockedPages: 7 });
  const ignored = report({ respectRobots: false, robotsBlockedPages: 0 });

  test("text, markdown, html and llm state it", () => {
    for (const render of [renderText, renderMarkdown, renderHtml, renderLlm]) {
      expect(render(honoured)).toContain("7 pages it disallows");
      expect(render(ignored)).toContain(NOT_HONOURED);
    }
  });

  test("json carries both fields in meta, and drops them on an old report", () => {
    const meta = (r: AuditReport) => (JSON.parse(renderJson(r)) as { meta: Record<string, unknown> }).meta;
    expect(meta(honoured)).toMatchObject({ schemaVersion: "1.20", respectRobots: true, robotsBlockedPages: 7 });
    expect(meta(ignored)).toMatchObject({ respectRobots: false, robotsBlockedPages: 0 });
    expect(meta(report({}))).not.toHaveProperty("respectRobots");
  });
});
