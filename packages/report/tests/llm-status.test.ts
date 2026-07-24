// #792: the LLM/agent-facing renderer (renderLlm) must surface a failed/blocked
// audit as an explicit <status> block. Without it a 0-page blocked run emits
// <score overall="N/A"> + empty <issues/>, which an agent reads as a clean pass.

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderLlm } from "../src/output/llm";

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    baseUrl: "https://example.com",
    timestamp: "2026-06-16T14:30:00.000Z",
    totalPages: 0,
    passed: 0,
    warnings: 0,
    failed: 0,
    ruleResults: {},
    ...overrides,
  };
}

describe("renderLlm failed/blocked status (#792)", () => {
  test("blocked report emits a <status state=\"blocked\"> block with reason + explanation", () => {
    const xml = renderLlm(
      baseReport({
        status: "blocked",
        statusReason: "Site blocked the crawler (bot protection / auth / rate limit)",
      }),
    );
    expect(xml).toContain('<status state="blocked"');
    expect(xml).toContain('reason="Site blocked the crawler');
    // Agent-readable, 3rd-person explanation + actionable next steps.
    expect(xml).toContain("The site refused the crawler");
    expect(xml).toContain("not a squirrelscan outage");
    expect(xml).toContain("allowlist the squirrelscan crawler");
    expect(xml).toContain("squirrel audit https://example.com");
    expect(xml).toContain("</status>");
    // No em-dashes in agent-facing copy.
    expect(xml.slice(xml.indexOf("<status"), xml.indexOf("</status>"))).not.toContain("—");
  });

  test("failed (unreachable) report emits a <status state=\"failed\"> block", () => {
    const xml = renderLlm(
      baseReport({ status: "failed", statusReason: "No pages were crawled" }),
    );
    expect(xml).toContain('<status state="failed"');
    expect(xml).toContain("No pages could be fetched from the site");
    expect(xml).toContain("squirrel audit https://example.com");
  });

  test("completed audit (no status) emits NO <status> block", () => {
    // status absent ⇒ a normal completed run; the block must not appear.
    const xml = renderLlm(baseReport({ totalPages: 5, passed: 10 }));
    expect(xml).not.toContain("<status");
  });
});
