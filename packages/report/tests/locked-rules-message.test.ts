// #780: pure unit coverage of the shared audience-aware locked-rules helper —
// every renderer (html/llm/markdown/text) and the CLI footer depend on this
// resolving the same audience for the same report shape.

import { describe, expect, test } from "bun:test";
import { lockedRulesMessage, type LockedRulesReportShape } from "../src/locked-rules";

const ONE_RULE = [{ id: "ai/llm-parsability", name: "LLM Parsability" }];
const TWO_RULES = [
  { id: "ai/llm-parsability", name: "LLM Parsability" },
  { id: "ai/site-metadata", name: "Site Metadata" },
];

describe("lockedRulesMessage", () => {
  test("returns null when there are no locked rules", () => {
    expect(lockedRulesMessage({})).toBeNull();
    expect(lockedRulesMessage({ lockedRules: [] })).toBeNull();
  });

  test("anonymous: signup upsell, plural heading", () => {
    const msg = lockedRulesMessage({ lockedRules: TWO_RULES });
    expect(msg).not.toBeNull();
    expect(msg?.audience).toBe("anonymous-upsell");
    expect(msg?.signedIn).toBe(false);
    expect(msg?.heading).toBe("2 more checks with cloud audits");
    expect(msg?.action).toContain("free squirrelscan account");
    expect(msg?.cta?.url).toBe("https://squirrelscan.com");
  });

  test("anonymous singular: 1 more check (not checks)", () => {
    const msg = lockedRulesMessage({ lockedRules: ONE_RULE });
    expect(msg?.heading).toBe("1 more check with cloud audits");
  });

  test("free, no --http, no quick coverage: credits upsell, no signup copy", () => {
    const msg = lockedRulesMessage({ lockedRules: ONE_RULE, cloudPlan: "free" });
    expect(msg?.audience).toBe("free-upsell");
    expect(msg?.signedIn).toBe(true);
    expect(msg?.heading).toBe("1 check didn't run this audit");
    expect(msg?.action).not.toContain("free squirrelscan account");
    expect(msg?.cta?.url).toBe("https://app.squirrelscan.com");
  });

  test("paid, quick coverage: coverage hint, not an outage", () => {
    const msg = lockedRulesMessage({
      lockedRules: ONE_RULE,
      cloudPlan: "paid",
      coverageMode: "quick",
    });
    expect(msg?.audience).toBe("quick-coverage");
    expect(msg?.action).toContain("quick coverage");
    expect(msg?.action).toContain("-C surface or -C full");
    expect(msg?.action).not.toContain("temporarily unavailable");
    expect(msg?.cta).toBeUndefined();
  });

  test("free, quick coverage: coverage hint wins over the credits upsell", () => {
    const msg = lockedRulesMessage({
      lockedRules: ONE_RULE,
      cloudPlan: "free",
      coverageMode: "quick",
    });
    expect(msg?.audience).toBe("quick-coverage");
    expect(msg?.action).not.toContain("out of credits");
  });

  test("paid, --http opt-out: deliberate choice, not unavailable", () => {
    const msg = lockedRulesMessage({
      lockedRules: ONE_RULE,
      cloudPlan: "paid",
      cloudMode: "http",
    });
    expect(msg?.audience).toBe("http-opt-out");
    expect(msg?.action).toContain("--http");
    expect(msg?.action).not.toContain("temporarily unavailable");
  });

  test("quick coverage wins over --http (cloud never runs in quick regardless of render mode)", () => {
    const msg = lockedRulesMessage({
      lockedRules: ONE_RULE,
      cloudPlan: "paid",
      coverageMode: "quick",
      cloudMode: "http",
    });
    expect(msg?.audience).toBe("quick-coverage");
  });

  test("paid, no quick/--http: temporarily-unavailable framing", () => {
    const msg = lockedRulesMessage({ lockedRules: ONE_RULE, cloudPlan: "paid" });
    expect(msg?.audience).toBe("paid-unavailable");
    expect(msg?.action).toContain("temporarily unavailable");
    expect(msg?.cta).toBeUndefined();
  });

  test("failed audit wins over every other cause — nothing ran, cloud or local", () => {
    for (const status of ["failed", "blocked"] as const) {
      const msg = lockedRulesMessage({
        lockedRules: ONE_RULE,
        cloudPlan: "paid",
        coverageMode: "quick",
        cloudMode: "http",
        status,
      });
      expect(msg?.audience).toBe("audit-failed");
      expect(msg?.action).toContain("completed audit");
    }
  });

  test("anonymous quick coverage keeps the signup upsell (quick-coverage branch requires signedIn)", () => {
    const msg = lockedRulesMessage({ lockedRules: ONE_RULE, coverageMode: "quick" });
    expect(msg?.audience).toBe("anonymous-upsell");
  });

  test("narrow report shape (only the fields the helper needs) type-checks and resolves", () => {
    const shape: LockedRulesReportShape = { lockedRules: ONE_RULE, cloudPlan: "paid" };
    expect(lockedRulesMessage(shape)?.audience).toBe("paid-unavailable");
  });
});
