import { describe, expect, test } from "bun:test";

import type { PlanId } from "../src/index";

import {
  getPlan,
  isSelfServePlan,
  PLANS,
  planAtLeast,
  planHasUnlimitedCredits,
  SELF_SERVE_PLAN_IDS,
} from "../src/plans";

const ALL_PLAN_IDS = Object.keys(PLANS) as PlanId[];

describe("plan definitions", () => {
  test("every plan declares the unlimitedCredits and selfServe flags", () => {
    for (const id of ALL_PLAN_IDS) {
      expect(typeof PLANS[id].unlimitedCredits).toBe("boolean");
      expect(typeof PLANS[id].selfServe).toBe("boolean");
    }
  });

  test("enterprise is the only unmetered plan", () => {
    const unmetered = ALL_PLAN_IDS.filter((id) => PLANS[id].unlimitedCredits);
    expect(unmetered).toEqual(["enterprise"]);
  });

  test("enterprise has no price and no per-seat pricing", () => {
    const plan = PLANS.enterprise;
    expect(plan.priceMonthUsd).toBeUndefined();
    expect(plan.priceYearUsd).toBeUndefined();
    expect(plan.perSeat).toBeUndefined();
    // Nothing to grant: the balance is frozen while unmetered.
    expect(plan.monthlyCredits).toBe(0);
  });

  test("enterprise carries the uncapped/top-tier entitlements", () => {
    const plan = PLANS.enterprise;
    expect(plan.maxWebsites).toBe(-1);
    expect(plan.maxMembers).toBe(-1);
    expect(plan.renderConcurrency).toBe(10);
    expect(plan.scheduledCrawls).toBe(true);
    expect(plan.customHeaders).toBe(true);
    expect(plan.maxPagesPerAudit).toBe(5000);
  });
});

describe("SELF_SERVE_PLAN_IDS", () => {
  test("lists exactly the plans a customer can buy themselves", () => {
    expect([...SELF_SERVE_PLAN_IDS]).toEqual(["free", "starter", "team"]);
  });

  // The whole point of the constant: an internal plan added later must not
  // silently appear on pricing, plan pickers or upgrade funnels.
  test("excludes every non-self-serve plan", () => {
    for (const id of ALL_PLAN_IDS) {
      expect(SELF_SERVE_PLAN_IDS.includes(id)).toBe(PLANS[id].selfServe);
    }
    expect(SELF_SERVE_PLAN_IDS).not.toContain("enterprise");
  });

  test("isSelfServePlan agrees, and an unknown id falls back to free", () => {
    expect(isSelfServePlan("team")).toBe(true);
    expect(isSelfServePlan("enterprise")).toBe(false);
    expect(isSelfServePlan("nope")).toBe(true); // → free, which is self-serve
  });
});

describe("getPlan", () => {
  test("resolves enterprise", () => {
    expect(getPlan("enterprise").id).toBe("enterprise");
    expect(getPlan("enterprise").name).toBe("Enterprise");
  });

  test("still falls back to free for an unknown id", () => {
    expect(getPlan("platinum").id).toBe("free");
  });
});

describe("planAtLeast", () => {
  test("enterprise ranks above team, so it inherits every entitlement gate", () => {
    for (const floor of ALL_PLAN_IDS) {
      expect(planAtLeast("enterprise", floor)).toBe(true);
    }
  });

  test("no lower tier reaches the enterprise floor", () => {
    expect(planAtLeast("free", "enterprise")).toBe(false);
    expect(planAtLeast("starter", "enterprise")).toBe(false);
    expect(planAtLeast("team", "enterprise")).toBe(false);
    expect(planAtLeast("bogus", "enterprise")).toBe(false);
  });

  test("the existing ordering is unchanged", () => {
    expect(planAtLeast("team", "starter")).toBe(true);
    expect(planAtLeast("starter", "team")).toBe(false);
    expect(planAtLeast("free", "starter")).toBe(false);
  });
});

describe("planHasUnlimitedCredits", () => {
  test("true only for enterprise", () => {
    expect(planHasUnlimitedCredits("enterprise")).toBe(true);
    expect(planHasUnlimitedCredits("team")).toBe(false);
    expect(planHasUnlimitedCredits("starter")).toBe(false);
    expect(planHasUnlimitedCredits("free")).toBe(false);
  });

  // A typo'd or future plan id must never accidentally read as unmetered.
  test("an unknown id is metered", () => {
    expect(planHasUnlimitedCredits("")).toBe(false);
    expect(planHasUnlimitedCredits("enterprize")).toBe(false);
  });
});
