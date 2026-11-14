// Pricing v12 (#2290, #2291, #801): 50 base + 2 per audited page, plus 1 per
// external link the cloud checks for an audit, cloud or signed-in CLI. These pin the shared pricing every surface quotes
// from (CLI preflight, dashboard estimate, the API's run cap and gate).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { CloudServiceId } from "../src/services";
import {
  auditCreditsPerPage,
  clampAuditPages,
  computeCost,
  CREDIT_COSTS,
  CREDIT_PRICING_VERSION,
  CREDIT_TOPUP,
  estimateAuditCap,
  estimateAuditRange,
  externalLinkBudget,
  minimumAuditCredits,
  TOPUP_BONUS_CURVE,
  topupBonusPercent,
  topupBonusSchedule,
  topupCreditsForUsd,
  topupQuote,
} from "../src/credits";

describe("pricing v13", () => {
  test("the version moved with the price: v13 adds the opt-in llm_rules_page feature", () => {
    expect(CREDIT_PRICING_VERSION).toBe(13);
  });

  test("50 base, 2 per audited page, 1 per external link", () => {
    expect(CREDIT_COSTS.audit_base).toEqual({ cost: 50, per: 1, unit: "run" });
    expect(CREDIT_COSTS.audit_page).toEqual({ cost: 2, per: 1, unit: "page" });
    expect(CREDIT_COSTS.external_link).toEqual({ cost: 1, per: 1, unit: "url" });
  });

  test("llm_rules_page is 2 per page and leaves the audit price untouched", () => {
    expect(CREDIT_COSTS.llm_rules_page).toEqual({ cost: 2, per: 1, unit: "page" });
    expect(computeCost("llm_rules_page", 50)).toBe(100);
    expect(minimumAuditCredits()).toBe(52);
    expect(estimateAuditCap({ maxPages: 100 })).toBe(250);
  });

  test("a standalone render keeps its 2-credit price", () => {
    expect(computeCost("render", 3)).toBe(6);
    expect(computeCost("render_cached", 3)).toBe(6);
  });

  test("a link-check call with no audit run stays free; an audit's bills external_link", () => {
    expect(computeCost("dead_links", 500)).toBe(0);
    expect(computeCost("external_link", 5)).toBe(5);
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

describe("third-party scan plumbing", () => {
  test("third_party_scan is a free ledger feature, however many units", () => {
    expect(CREDIT_COSTS.third_party_scan).toEqual({ cost: 0, per: 1, unit: "run" });
    expect(computeCost("third_party_scan", 1)).toBe(0);
    expect(computeCost("third_party_scan", 40)).toBe(0);
  });

  test("it does not move the audit price", () => {
    expect(minimumAuditCredits()).toBe(52);
  });

  test("third-party-scan is a cloud service id", () => {
    const id: CloudServiceId = "third-party-scan";
    expect(id).toBe("third-party-scan");
  });
});

// Sum of totalCredits over every whole dollar $10 to $1,000 in the fixture before repo#4314 raised the maximum.
const PRE_4314_SUM_10_TO_1000 = 57_113_875;

describe("top-up bonus curve (repo#3888)", () => {
  // The approved table (repo#3888, approved by Nik 2026-11-13: no bonus at $100 or below):
  // amount, bonus percent, credits, credits per $1.
  const table: [number, number, number, number][] = [
    [50, 0, 5_000, 100],
    [75, 0, 7_500, 100],
    [100, 0, 10_000, 100],
    [150, 2.6, 15_396, 102.6],
    [250, 5.7, 26_426, 105.7],
    [500, 11.3, 55_668, 111.3],
    [750, 15.9, 86_944, 115.9],
    [1_000, 20, 120_000, 120],
    // repo#4314 (approved by Nik 2026-11-14): the maximum is $5,000 and the bonus is a flat 20% above $1,000.
    [2_500, 20, 300_000, 120],
    [5_000, 20, 600_000, 120],
  ];

  for (const [usd, percent, credits, perUsd] of table) {
    test(`$${usd}: ${percent}% bonus, ${credits} credits, ${perUsd} per $1`, () => {
      const quote = topupQuote(usd);
      expect(quote.totalCredits).toBe(credits);
      expect(topupCreditsForUsd(usd)).toBe(credits);
      expect(quote.baseCredits + quote.bonusCredits).toBe(credits);
      const row = topupBonusSchedule([usd])[0]!;
      expect(row.bonusPercentRounded).toBe(percent);
      expect(row.creditsPerUsd).toBe(perUsd);
    });
  }

  test("at or below the floor a top-up is exactly 100 credits per $1 with no bonus", () => {
    for (let usd = CREDIT_TOPUP.minUsd; usd <= TOPUP_BONUS_CURVE.floorUsd; usd++) {
      expect(topupQuote(usd)).toMatchObject({ baseCredits: usd * 100, bonusCredits: 0, totalCredits: usd * 100 });
    }
  });

  test("no amount earns more than the cap, past the maximum included", () => {
    for (const usd of [1_000, 1_001, 5_000, 1_000_000]) {
      const q = topupQuote(usd);
      expect(q.bonusPercent).toBeLessThanOrEqual(TOPUP_BONUS_CURVE.capPercent);
      expect(q.bonusCredits).toBeLessThanOrEqual((q.baseCredits * TOPUP_BONUS_CURVE.capPercent) / 100);
    }
    for (let usd = CREDIT_TOPUP.minUsd; usd <= CREDIT_TOPUP.maxUsd; usd++) {
      expect(topupBonusPercent(usd)).toBeLessThanOrEqual(TOPUP_BONUS_CURVE.capPercent);
    }
  });

  test("credits never go down when the amount goes up by $1, over every whole dollar $10 to $5,000", () => {
    let previous = topupCreditsForUsd(CREDIT_TOPUP.minUsd);
    for (let usd = CREDIT_TOPUP.minUsd + 1; usd <= CREDIT_TOPUP.maxUsd; usd++) {
      const credits = topupCreditsForUsd(usd);
      expect(credits).toBeGreaterThanOrEqual(previous);
      previous = credits;
    }
  });

  test("the bonus percent never goes down and the credits per $1 never go down either", () => {
    let percent = 0;
    for (let usd = CREDIT_TOPUP.minUsd; usd <= CREDIT_TOPUP.maxUsd; usd++) {
      const p = topupBonusPercent(usd);
      expect(p).toBeGreaterThanOrEqual(percent);
      percent = p;
    }
  });

  test("credits are whole numbers and base plus bonus is the total", () => {
    for (let usd = CREDIT_TOPUP.minUsd; usd <= CREDIT_TOPUP.maxUsd; usd++) {
      const q = topupQuote(usd);
      expect(Number.isInteger(q.bonusCredits)).toBe(true);
      expect(Number.isInteger(q.totalCredits)).toBe(true);
      expect(q.totalCredits).toBe(q.baseCredits + q.bonusCredits);
    }
  });

  test("a fractional amount is floored, as before", () => {
    expect(topupCreditsForUsd(10.99)).toBe(1_000);
    expect(topupQuote(99.9)).toEqual(topupQuote(99));
  });

  test("the schedule lists the table amounts in order, and takes custom amounts", () => {
    expect(topupBonusSchedule().map((r) => r.usd)).toEqual(table.map(([usd]) => usd));
    expect(topupBonusSchedule([200]).map((r) => r.totalCredits)).toEqual([topupCreditsForUsd(200)]);
    expect(topupBonusSchedule([])).toEqual([]);
  });

  test("the curve numbers live in one object", () => {
    expect(TOPUP_BONUS_CURVE).toEqual({ floorUsd: 100, endUsd: 1_000, capPercent: 20, exponent: 0.7 });
    expect(CREDIT_TOPUP).toEqual({ minUsd: 10, maxUsd: 5_000, creditsPerUsd: 100 });
  });

  test("the curve ends at $1,000, not at the maximum: raising the maximum repriced nothing below it (repo#4314)", () => {
    expect(TOPUP_BONUS_CURVE.endUsd).toBeLessThan(CREDIT_TOPUP.maxUsd);
    expect(topupCreditsForUsd(1_000)).toBe(120_000);
    expect(topupCreditsForUsd(1_001)).toBe(120_120);
    expect(topupCreditsForUsd(5_000)).toBe(600_000);
    expect(topupQuote(5_000)).toMatchObject({ baseCredits: 500_000, bonusCredits: 100_000, bonusPercent: 20 });
  });

  test("every whole dollar $1,001 to $5,000 is exactly 120 credits per $1 (flat 20% bonus)", () => {
    for (let usd = TOPUP_BONUS_CURVE.endUsd + 1; usd <= CREDIT_TOPUP.maxUsd; usd++) {
      expect(topupQuote(usd)).toMatchObject({ baseCredits: usd * 100, bonusCredits: usd * 20, totalCredits: usd * 120 });
      expect(topupBonusPercent(usd)).toBe(20);
    }
  });

  test("every whole dollar $1 to $9 (below the minimum) still quotes 100 per $1, as before", () => {
    for (let usd = 1; usd < CREDIT_TOPUP.minUsd; usd++) expect(topupCreditsForUsd(usd)).toBe(usd * 100);
  });

  test("$5,001 is outside the purchasable range; $10 and $5,000 are its ends", () => {
    const inRange = (usd: number) => usd >= CREDIT_TOPUP.minUsd && usd <= CREDIT_TOPUP.maxUsd;
    expect(inRange(5_001)).toBe(false);
    expect(inRange(5_000)).toBe(true);
    expect(inRange(10)).toBe(true);
    expect(inRange(9)).toBe(false);
  });

  test("a non-finite or non-positive amount is a zero quote, never NaN or negative", () => {
    const zero = { usd: 0, baseCredits: 0, bonusCredits: 0, totalCredits: 0, bonusPercent: 0 };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5, -0.5, 0.9]) {
      expect(topupQuote(bad)).toEqual(zero);
      expect(topupCreditsForUsd(bad)).toBe(0);
      expect(topupBonusPercent(bad)).toBe(0);
    }
  });

  test("totalCredits for every whole dollar $10 to $5,000 matches the pinned list (a diff here is a price change)", () => {
    // Math.pow can differ in the last bits across engines; topupQuote rounds with toFixed(6) before flooring,
    // so the pinned list holds in Bun, workerd and browsers. Regenerate only when the curve is changed on purpose.
    const pinned = JSON.parse(
      readFileSync(new URL("./fixtures/topup-total-credits.json", import.meta.url), "utf8"),
    ) as Record<string, number>;
    const actual: Record<string, number> = {};
    for (let usd = CREDIT_TOPUP.minUsd; usd <= CREDIT_TOPUP.maxUsd; usd++) actual[String(usd)] = topupCreditsForUsd(usd);
    expect(Object.keys(pinned).length).toBe(4_991);
    expect(actual).toEqual(pinned);
  });

  test("the pinned $10 to $1,000 rows are the pre-repo#4314 list, unchanged (spot values and the rows' sum)", () => {
    const pinned = JSON.parse(
      readFileSync(new URL("./fixtures/topup-total-credits.json", import.meta.url), "utf8"),
    ) as Record<string, number>;
    let sum = 0;
    for (let usd = 10; usd <= 1_000; usd++) sum += pinned[String(usd)]!;
    expect(sum).toBe(PRE_4314_SUM_10_TO_1000);
    expect(pinned["999"]).toBe(119_864);
    expect(pinned["1001"]).toBe(120_120);
    expect(pinned["5000"]).toBe(600_000);
  });

  test("the table rows are spelled out in the pinned list", () => {
    const pinned = JSON.parse(
      readFileSync(new URL("./fixtures/topup-total-credits.json", import.meta.url), "utf8"),
    ) as Record<string, number>;
    expect(pinned["100"]).toBe(10_000);
    expect(pinned["250"]).toBe(26_426);
    expect(pinned["500"]).toBe(55_668);
    expect(pinned["750"]).toBe(86_944);
    expect(pinned["1000"]).toBe(120_000);
    expect(pinned["50"]).toBe(5_000);
    expect(pinned["75"]).toBe(7_500);
    expect(pinned["150"]).toBe(15_396);
    expect(pinned["2500"]).toBe(300_000);
    expect(pinned["5000"]).toBe(600_000);
  });
});
