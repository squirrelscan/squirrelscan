// #1386: the Agents score does not measure agent support. llms.txt, Markdown
// response and AGENTS.md are advisory; they are listed beside the score.

import { describe, expect, test } from "bun:test";

import {
  AGENTS_SCORE_MEASURES,
  agentSignalsLine,
  getAgentSignals,
} from "../src/agent-signals";
import { renderHtml } from "../src/output/html";
import { renderMarkdown } from "../src/output/markdown";
import { renderText } from "../src/output/text";
import type { AuditReport, ReportRuleResult } from "../src/types";

function rule(id: string, check: string, value: string | null): ReportRuleResult {
  return {
    meta: {
      id,
      name: id,
      description: "",
      category: id.split("/")[0],
      scope: "site",
      severity: "info",
      weight: 1,
    },
    checks: [{ name: check, status: "pass", message: "m", value }],
  };
}

function report(
  results: ReportRuleResult[],
  groups: AuditReport["healthScore"]["groups"],
): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-10-12T10:00:00.000Z",
    totalPages: 1,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: Object.fromEntries(results.map((r) => [r.meta.id, r])),
    healthScore: {
      overall: 80,
      categories: [],
      groups,
      passedCount: 0,
      warningCount: 0,
      errorCount: 0,
    },
  } as unknown as AuditReport;
}

const ruleSet = [
  rule("ax/llms-txt", "llms-txt-present", "present"),
  rule("ax/markdown-response", "markdown-response", "absent"),
  rule("ax/agents-md", "agents-md-present", "spa-fallback"),
];
const agents = [{ group: "ai", name: "Agents", score: 90, passed: 3, warnings: 0, failed: 0 }];
const seo = [{ group: "seo", name: "SEO", score: 90, passed: 3, warnings: 0, failed: 0 }];
const LINE =
  "Site-level signals (not scored): llms.txt present, Markdown response missing, AGENTS.md not checked";

describe("getAgentSignals", () => {
  test("maps present, missing and unchecked", () => {
    expect(getAgentSignals(report(ruleSet, agents)).map((s) => [s.id, s.status])).toEqual([
      ["llms-txt", "present"],
      ["markdown-response", "missing"],
      ["agents-md", "unchecked"],
    ]);
  });

  test("available counts as present; a missing rule is unchecked", () => {
    const signals = getAgentSignals(
      report([rule("ax/markdown-response", "markdown-response", "available")], agents),
    );
    expect(signals.map((s) => s.status)).toEqual(["unchecked", "present", "unchecked"]);
  });

  test("legacy ai/ rule ids are read", () => {
    const signals = getAgentSignals(report([rule("ai/llms-txt", "llms-txt-present", "absent")], agents));
    expect(signals[0].status).toBe("missing");
  });

  test("no ax results gives no signals", () => {
    expect(getAgentSignals(report([], agents))).toEqual([]);
  });

  test("line wording", () => {
    expect(agentSignalsLine(getAgentSignals(report(ruleSet, agents)))).toBe(LINE);
  });
});

describe("renderers", () => {
  test("text and markdown carry the sentence and line with an Agents group", () => {
    const r = report(ruleSet, agents);
    for (const out of [renderText(r), renderMarkdown(r)]) {
      expect(out).toContain(AGENTS_SCORE_MEASURES);
      expect(out).toContain(LINE);
    }
  });

  test("html carries them in the Agents card", async () => {
    const out = await renderHtml(report(ruleSet, agents));
    expect(out).toContain("data-agent-signals");
    expect(out).toContain("Markdown response missing");
  });

  test("no line without an Agents group", async () => {
    const r = report(ruleSet, seo);
    for (const out of [renderText(r), renderMarkdown(r), await renderHtml(r)]) {
      expect(out).not.toContain("Site-level signals");
      expect(out).not.toContain(AGENTS_SCORE_MEASURES);
    }
  });

  test("no line when the ax rules did not run", () => {
    const r = report([], agents);
    expect(renderText(r)).not.toContain("Site-level signals");
  });
});
