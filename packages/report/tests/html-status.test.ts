// #802: blocked/failed HTML reports must render statusReason exactly once —
// it used to appear twice (ScoreFailed ring + FailureNotice meta line).

import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../src/types";
import { renderHtml } from "../src/output/html";

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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderHtml failed/blocked statusReason (#802)", () => {
  test("blocked report renders the reason exactly once (FailureNotice)", () => {
    const reason = "Site blocked the crawler (bot protection / auth / rate limit)";
    const html = renderHtml(baseReport({ status: "blocked", statusReason: reason }));
    expect(countOccurrences(html, reason)).toBe(1);
    // The ring slot keeps its label; the notice carries the explanation.
    expect(html).toContain("Blocked");
    expect(html).toContain("Your site blocked the audit");
  });

  test("failed report renders the reason exactly once", () => {
    const reason = "No pages were crawled";
    const html = renderHtml(baseReport({ status: "failed", statusReason: reason }));
    expect(countOccurrences(html, reason)).toBe(1);
    expect(html).toContain("We couldn&#x27;t audit your site");
  });

  // #935 requires byte-identical visible copy to before the extraction. Pin
  // the exact rendered text (not just substrings) for both tones so a future
  // FailureNotice edit that hardcodes different wording — or drops the CLI
  // hint from its original position (3rd list item / folded into the 2nd
  // paragraph) — fails loudly instead of silently drifting.
  test("blocked report keeps the CLI hint as the ul's 3rd item, verbatim", () => {
    const html = renderHtml(baseReport({ status: "blocked" }));
    expect(html).toContain(
      "<li>Allowlist the squirrelscan crawler in your WAF or bot protection.</li>",
    );
    expect(html).toContain(
      "<li>Turn off bot fight mode (or the blocking rule) for the audit.</li>",
    );
    expect(html).toContain(
      "<li>Run the audit from a trusted network with <code>squirrel audit https://example.com</code>.</li>",
    );
    // Exactly 3 items in the failure-notice list — no separate CLI paragraph.
    expect(countOccurrences(html, "<li>Run the audit from a trusted network")).toBe(1);
  });

  test("failed report merges the CLI hint into the 2nd paragraph, verbatim", () => {
    const html = renderHtml(baseReport({ status: "failed" }));
    expect(html).toContain(
      "Check that the site is reachable and try again, or run it locally with " +
        "<code>squirrel audit https://example.com</code>.",
    );
  });
});
