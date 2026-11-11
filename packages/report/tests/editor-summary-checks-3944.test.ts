/**
 * #3944: the editor-summary request carries check-level evidence, so the cloud
 * summary can tell what the site already has from what it lacks.
 */
import { describe, expect, test } from "bun:test";

import { buildEditorSummaryRequest } from "../src/editor-summary";
import type { AuditReport } from "../src/types";

const check = (name: string, status: string, details?: Record<string, unknown>) => ({
  name,
  status,
  message: name,
  ...(details ? { details } : {}),
});

function report(ruleResults: Record<string, unknown>): AuditReport {
  return {
    baseUrl: "https://acme.example",
    timestamp: "2026-11-11T00:00:00.000Z",
    totalPages: 3,
    passed: 1,
    warnings: 1,
    failed: 0,
    ruleResults,
    generatorVersion: "1.2.3",
  } as unknown as AuditReport;
}

describe("buildEditorSummaryRequest checks (#3944)", () => {
  test("sends failing checks and the clean security and agent checks as rule|check keys", () => {
    const req = buildEditorSummaryRequest(
      report({
        "security/csp": {
          meta: { name: "CSP", category: "security", weight: 5 },
          checks: [check("csp-present", "pass"), check("csp-unsafe-scripts", "warn")],
        },
        "security/hsts": { meta: {}, checks: [check("hsts", "pass")] },
        "ax/llms-txt": {
          meta: {},
          checks: [check("llms-txt-present", "info"), check("llms-txt-format", "info")],
        },
        "ax/markdown-response": { meta: {}, checks: [check("markdown-response", "warn")] },
        // Not a confirmable family: its pass is not sent.
        "core/meta-title": { meta: {}, checks: [check("title", "pass")] },
        // A gap, not a finding.
        "ax/ai-crawlers": {
          meta: {},
          checks: [check("ai-crawler-access", "info", { inconclusive: true })],
        },
      }),
    );
    expect(req.checks).toEqual({
      failing: ["security/csp|csp-unsafe-scripts", "ax/markdown-response|markdown-response"],
      confirmed: [
        "security/csp|csp-present",
        "security/hsts|hsts",
        "ax/llms-txt|llms-txt-present",
        "ax/llms-txt|llms-txt-format",
      ],
    });
  });

  test("omits checks when there is nothing to send, and caps each list", () => {
    expect(buildEditorSummaryRequest(report({})).checks).toBeUndefined();
    const many = Object.fromEntries(
      Array.from({ length: 700 }, (_, i) => [
        `security/r${i}`,
        { meta: {}, checks: [check("c", "warn")] },
      ]),
    );
    expect(buildEditorSummaryRequest(report(many)).checks?.failing).toHaveLength(600);
  });
});
