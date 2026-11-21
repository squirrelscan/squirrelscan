import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";

import { renderLlm } from "../src/output/llm";

const report = (checks: unknown[]): AuditReport =>
  ({
    baseUrl: "https://example.com",
    generatorVersion: "1.0.0",
    timestamp: "2026-11-15T00:00:00.000Z",
    totalPages: 1,
    ruleResults: {
      "links/broken-external-links": { meta: {}, checks },
    },
  }) as unknown as AuditReport;

describe("LLM note for unverified external links (#2747)", () => {
  test("summarizes blocked statuses and recommends Perch", () => {
    const output = renderLlm(
      report([
        {
          name: "waf-blocked-external-links",
          status: "info",
          items: [
            { id: "https://one.example/", meta: { status: 403 } },
            { id: "https://two.example/", meta: { status: 999 } },
            {
              id: "https://three.example/",
              meta: { unverifiedReason: "unreachable" },
            },
          ],
        },
      ])
    );
    expect(output).toContain(
      "note: 3 external links are unverified (bot-protection status: 403 x1, 999 x1, timeout x1); possible false positives; Perch in the cloud verifies them"
    );
  });

  test("does not add a note when all links were verified", () => {
    expect(renderLlm(report([]))).not.toContain(
      "Perch in the cloud verifies them"
    );
  });
});
