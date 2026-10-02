// #1169 / #2290: preflight credit affordability. Pricing v11 charges 2 credits
// for every audited page (however it was fetched), so a signed-in audit's page
// cap is FITTED to what its credits cover instead of running out part-way or
// being refused. Math comes from the shared pricing source.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { describe, expect, test } from "bun:test";

import { computePreflightAffordability } from "../../src/cli/commands/audit";

const TOP_UP = "https://squirrelscan.com/dashboard";
const BASE = computeCost("audit_base", 1);
const PAGE = computeCost("audit_page", 1);

describe("computePreflightAffordability (#1169, #2290)", () => {
  test("estimate = base + 2 per page from the shared pricing source, rendering or not", () => {
    const maxPages = 500;
    const r = computePreflightAffordability({
      balance: 1_000_000,
      maxPages,
      maxCreditsPerAudit: 0,
      topUpUrl: TOP_UP,
    });
    expect(r.base).toBe(BASE);
    expect(r.pagesCost).toBe(computeCost("audit_page", maxPages));
    expect(r.estimate).toBe(BASE + PAGE * maxPages);
    expect(r.maxPages).toBe(maxPages);
    expect(r.clamped).toBe(false);
    expect(r.noticeLines).toEqual([]);
  });

  test("a 19-page audit is quoted at 88 credits (50 base + 19 × 2)", () => {
    const r = computePreflightAffordability({
      balance: 500,
      maxPages: 19,
      maxCreditsPerAudit: 1000,
      topUpUrl: TOP_UP,
    });
    expect(r.estimate).toBe(88);
    expect(r.clamped).toBe(false);
  });

  test("a balance below the full cap clamps the page cap instead of refusing", () => {
    // 100 credits: (100 − 50) / 2 = 25 pages of the 100 requested.
    const r = computePreflightAffordability({
      balance: 100,
      maxPages: 100,
      maxCreditsPerAudit: 1000,
      topUpUrl: TOP_UP,
      resetAt: "2026-11-01T00:00:00.000Z",
    });
    expect(r.maxPages).toBe(25);
    expect(r.clamped).toBe(true);
    expect(r.limitedBy).toBe("balance");
    expect(r.estimate).toBe(100);
    expect(r.noticeLines).toHaveLength(2);
    expect(r.noticeLines[0]).toContain("100 credits");
    expect(r.noticeLines[0]).toContain("25 of the 100 pages");
    expect(r.noticeLines[0]).toContain(
      `${BASE} base + ${PAGE} per audited page`
    );
    expect(r.noticeLines[1]).toContain("2026-11-01");
    expect(r.noticeLines[1]).toContain(TOP_UP);
  });

  test("a one-page clamp says page, not pages", () => {
    const r = computePreflightAffordability({
      balance: 52,
      maxPages: 19,
      maxCreditsPerAudit: 0,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(1);
    expect(r.noticeLines[0]).toContain("so this audit stops at 1 page.");
    expect(
      computePreflightAffordability({
        balance: 60,
        maxPages: 19,
        maxCreditsPerAudit: 0,
        topUpUrl: TOP_UP,
      }).noticeLines[0]
    ).toContain("so this audit stops at 5 pages.");
  });

  test("an odd balance rounds the page cap down, never past the balance", () => {
    const r = computePreflightAffordability({
      balance: 101,
      maxPages: 100,
      maxCreditsPerAudit: 0,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(25);
    expect(r.estimate).toBeLessThanOrEqual(101);
  });

  test("exactly the full cap does not clamp", () => {
    const r = computePreflightAffordability({
      balance: BASE + PAGE * 40,
      maxPages: 40,
      maxCreditsPerAudit: 0,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(40);
    expect(r.clamped).toBe(false);
  });

  test("[cloud] max_credits_per_audit clamps too, and says which limit bound", () => {
    // Default cap 1000 → (1000 − 50) / 2 = 475 pages.
    const r = computePreflightAffordability({
      balance: 1_000_000,
      maxPages: 1000,
      maxCreditsPerAudit: 1000,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(475);
    expect(r.limitedBy).toBe("cap");
    expect(r.noticeLines[0]).toContain("max_credits_per_audit = 1,000");
    expect(r.noticeLines[0]).toContain("475 of the 1,000 pages");
    expect(r.noticeLines[1]).not.toContain(TOP_UP);
  });

  test("max_credits_per_audit = 0 means no cap", () => {
    const r = computePreflightAffordability({
      balance: 1_000_000,
      maxPages: 5000,
      maxCreditsPerAudit: 0,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(5000);
  });

  test("a cap below one page leaves 0 pages, which the caller runs local-only", () => {
    const r = computePreflightAffordability({
      balance: 1_000_000,
      maxPages: 10,
      maxCreditsPerAudit: BASE + PAGE - 1,
      topUpUrl: TOP_UP,
    });
    expect(r.maxPages).toBe(0);
  });
});
