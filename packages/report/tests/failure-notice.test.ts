import { describe, expect, test } from "bun:test";
import { getAuditFailureNotice } from "../src/failure-notice";

describe("getAuditFailureNotice", () => {
  test("blocked: honest 'site blocked us' copy with allowlist guidance", () => {
    const notice = getAuditFailureNotice("blocked", "example.com");
    expect(notice).not.toBeNull();
    expect(notice?.tone).toBe("blocked");
    expect(notice?.heading).toBe("Your site blocked the audit");
    const text = [notice?.heading, ...(notice?.body ?? []), ...(notice?.steps ?? [])].join(" ");
    // Names the site as the blocker, not our infra.
    expect(text).toContain("refused our crawler");
    expect(text).toContain("not a squirrelscan outage");
    // Actionable: allowlist / bot fight mode.
    expect(notice?.steps.some((s) => s.toLowerCase().includes("allowlist"))).toBe(true);
    expect(notice?.steps.some((s) => s.toLowerCase().includes("bot fight mode"))).toBe(true);
    expect(notice?.cliCommand).toBe("squirrel audit example.com");
  });

  test("failed: distinct 'unreachable' copy, no block-specific guidance", () => {
    const notice = getAuditFailureNotice("failed", "example.com");
    expect(notice?.tone).toBe("failed");
    expect(notice?.heading).toBe("We couldn't audit your site");
    const text = [notice?.heading, ...(notice?.body ?? [])].join(" ");
    expect(text).toContain("unreachable");
    // No steps: an unreachable site isn't a WAF allowlist problem.
    expect(notice?.steps).toHaveLength(0);
    expect(notice?.cliCommand).toBe("squirrel audit example.com");
  });

  test("blocked and failed copy are distinct", () => {
    const blocked = getAuditFailureNotice("blocked", "example.com");
    const failed = getAuditFailureNotice("failed", "example.com");
    expect(blocked?.heading).not.toBe(failed?.heading);
  });

  test("never blames squirrelscan infra or claims a clean pass", () => {
    for (const status of ["blocked", "failed"] as const) {
      const notice = getAuditFailureNotice(status, "example.com");
      const text = JSON.stringify(notice).toLowerCase();
      expect(text).not.toContain("temporarily unavailable");
      expect(text).not.toContain("no issues found");
      expect(text).not.toContain("cloud service");
    }
  });

  test("returns null for a normal audit (completed / partial / absent)", () => {
    expect(getAuditFailureNotice("completed", "example.com")).toBeNull();
    expect(getAuditFailureNotice("partial", "example.com")).toBeNull();
    expect(getAuditFailureNotice(null, "example.com")).toBeNull();
    expect(getAuditFailureNotice(undefined, "example.com")).toBeNull();
  });
});
