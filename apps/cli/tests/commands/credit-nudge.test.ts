import { beforeEach, describe, expect, it } from "bun:test";

import {
  CREDIT_NUDGE_WINDOW_MS,
  claimCreditNudge,
  creditNudgeLine,
  resetCreditNudgeCap,
} from "../../src/cli/credit-nudge";

describe("credit nudge (repo#1118)", () => {
  beforeEach(() => resetCreditNudgeCap());

  it("names the balance and the next estimate", () => {
    const line = creditNudgeLine({
      balance: 40,
      nextEstimate: 64,
      url: "https://x/upgrade",
      topUp: false,
    });
    expect(line).toContain("Balance 40 credits, next audit needs ~64");
    expect(line).toContain("Upgrade: https://x/upgrade");
  });

  it("speaks at most once in the window when called in a loop", () => {
    let shown = 0;
    for (let i = 0; i < 20; i++) {
      if (claimCreditNudge({ key: "org-a", now: 1000 + i })) shown++;
    }
    expect(shown).toBe(1);
  });

  it("is capped per account and honours the persisted timestamp", () => {
    const now = Date.now();
    expect(claimCreditNudge({ key: "a", now })).toBe(true);
    expect(claimCreditNudge({ key: "b", now })).toBe(true);
    resetCreditNudgeCap();
    const recent = new Date(now - 1000).toISOString();
    expect(claimCreditNudge({ key: "a", now, lastShownAt: recent })).toBe(
      false
    );
    const old = new Date(now - CREDIT_NUDGE_WINDOW_MS - 1).toISOString();
    expect(claimCreditNudge({ key: "a", now, lastShownAt: old })).toBe(true);
  });
});
