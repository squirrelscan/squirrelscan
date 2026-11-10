// The audit outcome in the JSON and LLM reports (#1657).

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

const failedPublish = {
  exit_code: 1,
  status: "completed" as const,
  publish: { status: "failed" as const, reason: "PAYLOAD_TOO_LARGE" },
};

describe("outcome in the JSON report", () => {
  test("carries exit_code, status and the publish result with its reason", () => {
    const parsed = JSON.parse(renderJson(report({ outcome: failedPublish })));
    expect(parsed.outcome).toEqual(failedPublish);
  });

  test("a skipped publish says why", () => {
    const outcome = { exit_code: 0, status: "completed" as const, publish: { status: "skipped" as const, reason: "offline" } };
    expect(JSON.parse(renderJson(report({ outcome }))).outcome).toEqual(outcome);
  });

  test("a report with no outcome (read back from the store) has no outcome field", () => {
    expect("outcome" in JSON.parse(renderJson(report()))).toBe(false);
  });
});

describe("outcome in the LLM report", () => {
  const render = (r: AuditReport) => renderLlm(r as Parameters<typeof renderLlm>[0], { version: "0.0.0", includePassed: false, includeInfo: false });

  test("an <outcome> element with the exit code, status and publish result", () => {
    expect(render(report({ outcome: failedPublish }))).toContain(
      '<outcome exit-code="1" status="completed" publish="failed" publish-reason="PAYLOAD_TOO_LARGE"/>',
    );
  });

  test("a published report has no publish reason", () => {
    const outcome = { exit_code: 0, status: "completed" as const, publish: { status: "published" as const } };
    expect(render(report({ outcome }))).toContain('<outcome exit-code="0" status="completed" publish="published"/>');
  });

  test("no outcome, no element", () => {
    expect(render(report())).not.toContain("<outcome");
  });
});
