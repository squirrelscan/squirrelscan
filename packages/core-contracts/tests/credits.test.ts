// Pricing v11 (#2290, #2291): 50 base + 2 per audited page, plus 1 per external
// link a cloud audit checks. These pin the shared pricing every surface quotes
// from (CLI preflight, dashboard estimate, the API's run cap and gate).

import { describe, expect, test } from "bun:test";

import {
  auditCreditsPerPage,
  clampAuditPages,
  computeCost,
  CREDIT_COSTS,
  CREDIT_PRICING_VERSION,
  estimateAuditCap,
  estimateAuditRange,
  externalLinkBudget,
  minimumAuditCredits,
} from "../src/credits";

describe("pricing v11", () => {
  test("the version moved with the price", () => {
    expect(CREDIT_PRICING_VERSION).toBe(11);
  });

  test("50 base, 2 per audited page, 1 per external link", () => {
    expect(CREDIT_COSTS.audit_base).toEqual({ cost: 50, per: 1, unit: "run" });
    expect(CREDIT_COSTS.audit_page).toEqual({ cost: 2, per: 1, unit: "page" });
    expect(CREDIT_COSTS.external_link).toEqual({ cost: 1, per: 1, unit: "url" });
  });

  test("a standalone render keeps its 2-credit price", () => {
    expect(computeCost("render", 3)).toBe(6);
    expect(computeCost("render_cached", 3)).toBe(6);
  });

  test("a signed-in CLI's own link checks stay free", () => {
    expect(computeCost("dead_links", 500)).toBe(0);
  });
});

describe("estimateAuditCap", () => {
  test("a 19-page audit is 88 credits", () => {
    expect(estimateAuditCap({ maxPages: 19 })).toBe(88);
  });

  test("a cloud audit checking external links reserves one per page: 19 pages → 107", () => {
    expect(estimateAuditCap({ maxPages: 19, cloudExternalLinks: true })).toBe(50 + 19 * 3);
    expect(externalLinkBudget(19)).toBe(19);
    expect(auditCreditsPerPage(true)).toBe(3);
    expect(auditCreditsPerPage()).toBe(2);
  });

  test("never quotes fewer than one page", () => {
    expect(estimateAuditCap({ maxPages: 0 })).toBe(52);
    expect(estimateAuditCap({ maxPages: 0.4 })).toBe(52);
  });

  test("the range runs from a one-page audit to the cap", () => {
    expect(estimateAuditRange({ maxPages: 100 })).toEqual({ min: 52, max: 250 });
    expect(estimateAuditRange({ maxPages: 100, cloudExternalLinks: true })).toEqual({
      min: 52,
      max: 350,
    });
  });
});

describe("clampAuditPages", () => {
  test("a balance that covers the cap leaves it alone", () => {
    expect(clampAuditPages({ maxPages: 100, balance: 250 })).toEqual({
      maxPages: 100,
      requestedMaxPages: 100,
      clamped: false,
    });
  });

  test("a short balance fits the cap to floor((balance − 50) / 2)", () => {
    expect(clampAuditPages({ maxPages: 100, balance: 99 })).toEqual({
      maxPages: 24,
      requestedMaxPages: 100,
      clamped: true,
      limitedBy: "balance",
    });
  });

  test("external links make each page cost 3: floor((balance − 50) / 3)", () => {
    expect(
      clampAuditPages({ maxPages: 100, balance: 110, cloudExternalLinks: true }).maxPages,
    ).toBe(20);
  });

  test("below one page comes back as 0, for the caller to refuse", () => {
    expect(clampAuditPages({ maxPages: 10, balance: minimumAuditCredits() - 1 }).maxPages).toBe(0);
    expect(clampAuditPages({ maxPages: 10, balance: minimumAuditCredits() }).maxPages).toBe(1);
    expect(minimumAuditCredits(true)).toBe(53);
    expect(
      clampAuditPages({ maxPages: 10, balance: 52, cloudExternalLinks: true }).maxPages,
    ).toBe(0);
  });

  test("a customer cap clamps too, and the tighter of the two limits wins", () => {
    expect(clampAuditPages({ maxPages: 1000, balance: 100_000, cap: 1000 })).toMatchObject({
      maxPages: 475,
      limitedBy: "cap",
    });
    expect(clampAuditPages({ maxPages: 1000, balance: 150, cap: 1000 })).toMatchObject({
      maxPages: 50,
      limitedBy: "balance",
    });
  });

  test("a cap of 0 is no cap, and an unmetered or unknown balance bounds nothing", () => {
    expect(clampAuditPages({ maxPages: 5000, balance: 100_000, cap: 0 }).clamped).toBe(false);
    expect(clampAuditPages({ maxPages: 5000, balance: 0, unlimited: true }).clamped).toBe(false);
    expect(clampAuditPages({ maxPages: 5000, balance: null }).clamped).toBe(false);
  });

  test("the clamped cap never costs more than the credits that bound it", () => {
    for (let balance = 52; balance < 400; balance += 7) {
      for (const cloudExternalLinks of [false, true]) {
        const { maxPages } = clampAuditPages({ maxPages: 1000, balance, cloudExternalLinks });
        if (maxPages === 0) continue;
        expect(estimateAuditCap({ maxPages, cloudExternalLinks })).toBeLessThanOrEqual(balance);
        expect(estimateAuditCap({ maxPages: maxPages + 1, cloudExternalLinks })).toBeGreaterThan(
          balance,
        );
      }
    }
  });
});
