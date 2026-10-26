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

// squirrelscan/repo#3480: retrying a URL that redirects off-site fails the
// same way, so the retry line gives way to the destination, offered for the
// user to confirm, or to "needs authentication" for a sign-in page.
describe("renderLlm off-site redirect failure (#3480)", () => {
  const OFF_SITE = "Redirect from example.com could not be followed: redirected off-site to www.example.org";

  test("offers the destination's exact command, for the user to confirm", () => {
    const xml = renderLlm(
      baseReport({
        status: "failed",
        statusReason: OFF_SITE,
        finalUrl: "https://www.example.org/welcome",
      }),
    );
    expect(xml).toContain(
      "The entry URL redirects to https://www.example.org. If the user confirms that is the site they meant, audit it with `squirrel audit https://www.example.org`.",
    );
    expect(xml).not.toContain("to retry locally");
  });

  test("a sign-in page says it needs authentication and offers no command", () => {
    const xml = renderLlm(
      baseReport({
        status: "failed",
        statusReason: OFF_SITE,
        finalUrl: "https://login.example.org/oauth?return=%2F",
      }),
    );
    expect(xml).toContain("https://login.example.org is a sign-in page");
    expect(xml).toContain("guides/failed-audits#access-gateway");
    expect(xml).not.toContain("squirrel audit https://login.example.org");
  });

  test("any other failure, or a redirect with no recorded target, keeps the retry line", () => {
    for (const overrides of [
      { statusReason: "No pages were crawled", finalUrl: "https://www.example.org/" },
      { statusReason: OFF_SITE },
    ]) {
      const xml = renderLlm(baseReport({ status: "failed", ...overrides }));
      expect(xml).toContain("Run the CLI with `squirrel audit https://example.com` to retry locally.");
      expect(xml).not.toContain("The entry URL redirects to");
    }
  });
});
