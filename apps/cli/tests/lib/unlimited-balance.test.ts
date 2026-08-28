// The CLI's reading of an UNMETERED account (the internal enterprise plan).
//
// `GET /v1/credits` returns `balance.unlimited: true` and leaves the stored
// numbers frozen — often 0, because nothing has ever been deducted. Every CLI
// surface that used to compare `balance.total` against a price would therefore
// get the wrong answer: #1588's exact failure mode (a real 5-credit balance
// dropping every run to local-only with exit 0), except here the account can
// actually afford everything.
//
// The flag is OPTIONAL on the wire: this binary talks to whatever server it
// finds, and a server predating the plan omits it. Absent must read as metered.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { describe, expect, test } from "bun:test";

import {
  computePreflightAffordability,
  consentEstimateLine,
  lowBalanceFooterLines,
} from "../../src/cli/commands/audit";
import { renderConcurrencyUpsellHint } from "../../src/controllers/audit";
import {
  formatBalance,
  isUnlimitedBalance,
  preflightBalanceOf,
} from "../../src/lib/balance";

const AUDIT_BASE = computeCost("audit_base", 1);
const TOP_UP = "https://squirrelscan.com/upgrade?src=cli-audit";
const text = (lines: string[]) => lines.join("\n");

describe("isUnlimitedBalance", () => {
  test("true only for an explicit true", () => {
    expect(isUnlimitedBalance({ unlimited: true })).toBe(true);
  });

  // An older server omits the field entirely. Reading that as "unlimited" would
  // let a broke free org sail past every affordability gate.
  test("an absent, null or undefined flag is metered", () => {
    expect(isUnlimitedBalance({})).toBe(false);
    expect(isUnlimitedBalance({ unlimited: undefined })).toBe(false);
    expect(isUnlimitedBalance(undefined)).toBe(false);
    expect(isUnlimitedBalance(null)).toBe(false);
  });

  test("does not coerce a truthy non-boolean", () => {
    expect(
      isUnlimitedBalance({ unlimited: "yes" } as unknown as {
        unlimited?: boolean;
      })
    ).toBe(false);
  });
});

describe("formatBalance", () => {
  test('says "unlimited" instead of the frozen number', () => {
    expect(formatBalance(0, true)).toBe("unlimited");
    expect(formatBalance(5000, true)).toBe("unlimited");
  });

  test("groups a metered balance", () => {
    expect(formatBalance(12345, false)).toBe("12,345");
  });
});

describe("preflightBalanceOf", () => {
  test("hands a confirm prompt the word, not the frozen total", () => {
    expect(preflightBalanceOf({ total: 0, unlimited: true })).toBe("unlimited");
  });

  test("passes a metered total straight through", () => {
    expect(preflightBalanceOf({ total: 250 })).toBe(250);
    expect(preflightBalanceOf({ total: 250, unlimited: false })).toBe(250);
  });
});

describe("computePreflightAffordability (#1169) on an unmetered plan", () => {
  // A frozen 0 balance against a 500-page render estimate is the worst case:
  // metered, that is a guaranteed shortfall warning + abort prompt.
  test("never reports a shortfall, however low the frozen balance", () => {
    const metered = computePreflightAffordability({
      balance: 0,
      maxPages: 500,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
    });
    expect(metered.shortfall).toBe(true);
    expect(metered.warningLines.length).toBeGreaterThan(0);

    const unmetered = computePreflightAffordability({
      balance: 0,
      maxPages: 500,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
      unlimited: true,
    });
    expect(unmetered.shortfall).toBe(false);
    expect(unmetered.warningLines).toEqual([]);
    // The estimate itself is still computed — spend is accounted, just not gated.
    expect(unmetered.estimate).toBe(metered.estimate);
  });

  test("unlimited: false is exactly today's behaviour", () => {
    const r = computePreflightAffordability({
      balance: 0,
      maxPages: 10,
      cloudRendering: "browser",
      topUpUrl: TOP_UP,
      unlimited: false,
    });
    expect(r.shortfall).toBe(true);
  });
});

describe("lowBalanceFooterLines on an unmetered plan", () => {
  test("never warns and never offers a top-up, at any balance", () => {
    for (const balance of [0, 1, AUDIT_BASE - 1, 10_000]) {
      expect(
        lowBalanceFooterLines({
          balance,
          monthlyCredits: 0,
          plan: "paid",
          unlimited: true,
        })
      ).toEqual([]);
    }
  });

  // The upsell is the part that must not leak: an enterprise org being told to
  // upgrade is the one visible way the internal plan could surface to a user.
  test("a metered paid plan at the same balance DOES warn (control)", () => {
    const lines = lowBalanceFooterLines({
      balance: 0,
      monthlyCredits: 0,
      plan: "paid",
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(text(lines)).toContain("Top up");
  });

  test("a free plan pitch is suppressed too when unmetered", () => {
    expect(
      lowBalanceFooterLines({
        balance: 0,
        monthlyCredits: 500,
        plan: "free",
        unlimited: true,
      })
    ).toEqual([]);
  });
});

describe("consentEstimateLine on an unmetered plan", () => {
  test('reads "unlimited credits", never the frozen number', () => {
    const line = consentEstimateLine({
      maxPages: 100,
      balance: 0,
      maxCredits: 0,
      unlimited: true,
    });
    expect(line).toContain("Balance: unlimited credits.");
    expect(line).not.toContain("Balance: 0 credits");
  });

  test("a metered account still sees its number", () => {
    const line = consentEstimateLine({
      maxPages: 100,
      balance: 1234,
      maxCredits: 0,
    });
    expect(line).toContain("Balance: 1,234 credits.");
  });
});

describe("upsell hints", () => {
  // Enterprise sits above every tier, so there is nothing to sell it — and the
  // plan is internal, so naming it in CLI output would leak it.
  test("no render-concurrency upsell for enterprise", () => {
    expect(renderConcurrencyUpsellHint("enterprise")).toBe("");
  });

  test("the existing free/pro hints are unchanged", () => {
    expect(renderConcurrencyUpsellHint("free")).toContain("upgrade to Pro");
    expect(renderConcurrencyUpsellHint("starter")).toContain("upgrade to Team");
    expect(renderConcurrencyUpsellHint("team")).toBe("");
  });
});
