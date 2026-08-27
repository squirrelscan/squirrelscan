// What the CLI says when credits run out.
//
// Measured on prod 2026-08-26: 12 of the 13 orgs that ever ran their balance
// below the cost of one audit never ran another audit. The CLI's answer at that
// moment was the server's bare sentence, and `squirrel credits` pointed at
// https://squirrelscan.com/account/credits — a URL that has never been a route.
// So these assert the two things that were missing: a working URL, and a price.

import { computeCost } from "@squirrelscan/core-contracts/credits";
import { getPlan } from "@squirrelscan/core-contracts/plans";
import { describe, expect, test } from "bun:test";

import {
  lowBalanceFooterLines,
  registerFailureLines,
} from "../../src/cli/commands/audit";
import {
  AUDIT_BASE_CREDITS,
  PRO_HEADLINE,
  proPitchLines,
  upgradeUrl,
} from "../../src/lib/upgrade";

const PRO = getPlan("starter");
const UPGRADE = "https://squirrelscan.com/upgrade?src=cli-audit";
const text = (lines: string[]) => lines.join("\n");

describe("the upgrade offer", () => {
  test("names the price, the term price and the monthly grant", () => {
    expect(PRO_HEADLINE).toContain(`$${PRO.priceMonthUsd}`);
    expect(PRO_HEADLINE).toContain(`$${PRO.priceYearUsd}`);
    expect(PRO_HEADLINE).toContain(PRO.monthlyCredits.toLocaleString("en-US"));
  });

  test('says "Pro", never the internal plan id', () => {
    const pitch = text(proPitchLines("cli-credits"));
    expect(pitch).toContain("Pro");
    expect(pitch).not.toContain("starter");
  });

  test("carries a squirrelscan.com/upgrade URL, not the dead /account/credits", () => {
    const pitch = text(proPitchLines("cli-credits"));
    expect(pitch).toContain("https://squirrelscan.com/upgrade?src=cli-credits");
    expect(pitch).not.toContain("/account/credits");
    expect(upgradeUrl("cli")).toBe("https://squirrelscan.com/upgrade?src=cli");
  });

  test("the audit base tracks the shared pricing source", () => {
    expect(AUDIT_BASE_CREDITS).toBe(computeCost("audit_base", 1));
  });
});

describe("registerFailureLines", () => {
  const insufficient = {
    code: "INSUFFICIENT_CREDITS",
    message: "Insufficient credits for the audit base",
    balance: 12,
  };

  test("out of credits gets the balance, the price and a working upgrade URL", () => {
    const out = text(registerFailureLines(insufficient));
    expect(out).toContain("12 credits");
    expect(out).toContain(String(AUDIT_BASE_CREDITS));
    expect(out).toContain(`$${PRO.priceMonthUsd}`);
    expect(out).toContain(UPGRADE);
  });

  test("says the audit itself still ran, so the warning isn't read as a failure", () => {
    expect(text(registerFailureLines(insufficient)).toLowerCase()).toContain(
      "ran locally"
    );
  });

  test("degrades without a balance rather than printing null", () => {
    const out = text(registerFailureLines({ ...insufficient, balance: null }));
    expect(out).not.toContain("null");
    expect(out).toContain(UPGRADE);
  });

  test("other definitive failures are not turned into a plan pitch", () => {
    for (const code of ["WEBSITE_LIMIT", "ORG_LOCKED"]) {
      const out = text(
        registerFailureLines({
          code,
          message: "Website limit reached.",
          balance: null,
        })
      );
      expect(out).toContain("Website limit reached.");
      expect(out).not.toContain(UPGRADE);
      expect(out).not.toContain(`$${PRO.priceMonthUsd}`);
    }
  });
});

describe("lowBalanceFooterLines", () => {
  const free = getPlan("free").monthlyCredits;

  test("warns at 20% of the grant, while credits remain to spend", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 80, monthlyCredits: free, plan: "free" })
    );
    expect(out).toContain("80 credits left");
    expect(out).toContain(UPGRADE);
  });

  test("stays quiet on a healthy balance", () => {
    expect(
      lowBalanceFooterLines({
        balance: 100,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({
        balance: free,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
  });

  test("a stranded sub-base balance says the next audit can't start", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 12, monthlyCredits: free, plan: "free" })
    );
    expect(out).toContain(`below the ${AUDIT_BASE_CREDITS}-credit audit base`);
    expect(out).toContain(UPGRADE);
  });

  test("paid plans get a top-up link, not a pitch for the plan they're on", () => {
    const out = text(
      lowBalanceFooterLines({ balance: 12, monthlyCredits: 3000, plan: "paid" })
    );
    expect(out).toContain(UPGRADE);
    expect(out).not.toContain(`$${PRO.priceMonthUsd}`);
  });

  test("anonymous and unknown balances print nothing", () => {
    expect(
      lowBalanceFooterLines({
        balance: 0,
        monthlyCredits: free,
        plan: "anonymous",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({
        balance: null,
        monthlyCredits: free,
        plan: "free",
      })
    ).toEqual([]);
  });

  test("a plan with no monthly grant warns only once it can't buy an audit", () => {
    // Team pools credits per seat, so there is no share to measure against.
    expect(
      lowBalanceFooterLines({
        balance: AUDIT_BASE_CREDITS,
        monthlyCredits: 0,
        plan: "paid",
      })
    ).toEqual([]);
    expect(
      lowBalanceFooterLines({ balance: 10, monthlyCredits: 0, plan: "paid" })
        .length
    ).toBeGreaterThan(0);
  });
});
