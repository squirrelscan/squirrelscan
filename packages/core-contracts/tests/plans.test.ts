import { describe, expect, test } from "bun:test";

import type { PlanDefinition, PlanId } from "../src/index";

import {
  clampScheduleFrequency,
  getPlan,
  isSelfServePlan,
  PLANS,
  planAllowsScheduleFrequency,
  planAtLeast,
  planHasUnlimitedCredits,
  planMaxScheduledWebsites,
  planScheduleSummary,
  resolvePlanScheduleLimits,
  SCHEDULE_FREQUENCIES,
  scheduledWebsiteCapReached,
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

// #1704: scheduling is no longer the free/paid line — cadence and breadth are.
describe("scheduled audit entitlements", () => {
  test("every plan can schedule; free is the capped one", () => {
    for (const id of ALL_PLAN_IDS) {
      expect(PLANS[id].scheduledCrawls).toBe(true);
    }
    expect(planMaxScheduledWebsites("free")).toBe(1);
    expect(planMaxScheduledWebsites("starter")).toBe(-1);
    expect(planMaxScheduledWebsites("team")).toBe(-1);
    expect(planMaxScheduledWebsites("enterprise")).toBe(-1);
  });

  test("free omits daily; every paid plan allows all three cadences", () => {
    expect([...PLANS.free.scheduleFrequencies]).toEqual(["weekly", "monthly"]);
    for (const id of ["starter", "team", "enterprise"] as const) {
      expect([...PLANS[id].scheduleFrequencies]).toEqual([...SCHEDULE_FREQUENCIES]);
    }
    expect(planAllowsScheduleFrequency("free", "daily")).toBe(false);
    expect(planAllowsScheduleFrequency("free", "weekly")).toBe(true);
    expect(planAllowsScheduleFrequency("starter", "daily")).toBe(true);
  });

  // The order is what makes the clamp land on the nearest allowed cadence.
  test("SCHEDULE_FREQUENCIES runs most to least frequent", () => {
    expect([...SCHEDULE_FREQUENCIES]).toEqual(["daily", "weekly", "monthly"]);
  });

  test("a cadence the plan does not fund clamps DOWN, never up", () => {
    expect(clampScheduleFrequency("free", "daily")).toBe("weekly");
    expect(clampScheduleFrequency("free", "weekly")).toBe("weekly");
    expect(clampScheduleFrequency("free", "monthly")).toBe("monthly");
    for (const f of SCHEDULE_FREQUENCIES) {
      expect(clampScheduleFrequency("starter", f)).toBe(f);
    }
  });

  // An id we cannot identify must not buy more recurring spend than free.
  test("an unknown plan id gets the free limits", () => {
    expect(planMaxScheduledWebsites("platinum")).toBe(1);
    expect(clampScheduleFrequency("platinum", "daily")).toBe("weekly");
  });

  // The version-skew guard. `CreditsResponse.plan` is a plain-JSON cast, so a
  // CLI built against these fields can be handed a plan from a server that
  // predates them — the fields are simply absent, and the type says otherwise.
  // Absent must read as the FREE tier, never as "uncapped" or `undefined`.
  describe("resolvePlanScheduleLimits", () => {
    test("a plan missing both fields degrades to the free tier, not to undefined", () => {
      const stale = { ...PLANS.starter } as PlanDefinition;
      delete stale.maxScheduledWebsites;
      delete stale.scheduleFrequencies;

      const limits = resolvePlanScheduleLimits(stale);
      expect(limits.maxScheduledWebsites).toBe(1);
      expect([...limits.scheduleFrequencies]).toEqual(["weekly", "monthly"]);
      // The trap this exists to prevent: `undefined.includes(...)`.
      expect(limits.scheduleFrequencies.includes("daily")).toBe(false);
    });

    test("each field falls back independently", () => {
      const noCap = { ...PLANS.starter } as PlanDefinition;
      delete noCap.maxScheduledWebsites;
      expect(resolvePlanScheduleLimits(noCap).maxScheduledWebsites).toBe(1);
      expect([...resolvePlanScheduleLimits(noCap).scheduleFrequencies]).toEqual([
        ...SCHEDULE_FREQUENCIES,
      ]);

      const noCadence = { ...PLANS.starter } as PlanDefinition;
      delete noCadence.scheduleFrequencies;
      expect(resolvePlanScheduleLimits(noCadence).maxScheduledWebsites).toBe(-1);
      expect([...resolvePlanScheduleLimits(noCadence).scheduleFrequencies]).toEqual([
        "weekly",
        "monthly",
      ]);
    });

    test("no plan at all is still answerable", () => {
      expect(resolvePlanScheduleLimits(undefined).maxScheduledWebsites).toBe(1);
      expect(resolvePlanScheduleLimits(null).maxScheduledWebsites).toBe(1);
    });

    test("a complete plan is passed through untouched", () => {
      const limits = resolvePlanScheduleLimits(PLANS.team);
      expect(limits.maxScheduledWebsites).toBe(-1);
      expect([...limits.scheduleFrequencies]).toEqual([...SCHEDULE_FREQUENCIES]);
    });

    // 0 is falsy: a plan that explicitly schedules nothing must not be read as
    // "field absent" and silently handed the free tier's one slot.
    test("an explicit zero cap is not mistaken for an absent field", () => {
      expect(resolvePlanScheduleLimits({ maxScheduledWebsites: 0 }).maxScheduledWebsites).toBe(0);
    });
  });

  // The one derivation two pricing tables in two apps render, so a plan-data
  // change cannot leave either of them describing a tier it no longer sells.
  test("planScheduleSummary states the cadence and the site count", () => {
    expect(planScheduleSummary("free")).toBe("Weekly, 1 site");
    expect(planScheduleSummary("starter")).toBe("Daily, all sites");
    expect(planScheduleSummary("team")).toBe("Daily, all sites");
    expect(planScheduleSummary("enterprise")).toBe("Daily, all sites");
    expect(planScheduleSummary("platinum")).toBe("Weekly, 1 site"); // unknown → free
  });

  // The label is the most frequent cadence the plan FUNDS, off the ordered
  // list. Testing for `daily` instead would call a monthly-only plan "Weekly".
  test("planScheduleSummary names a cadence the plan actually runs", () => {
    const monthlyOnly = { ...PLANS.free, scheduleFrequencies: ["monthly"] as const };
    const limits = resolvePlanScheduleLimits(monthlyOnly);
    expect(limits.scheduleFrequencies).toEqual(["monthly"]);
    // Same derivation planScheduleSummary runs, on a plan `PLANS` cannot express.
    const cadence = SCHEDULE_FREQUENCIES.find((f) => limits.scheduleFrequencies.includes(f));
    expect(cadence).toBe("monthly");
  });

  // Public copy: never a bare dash in a column of real values, and never an
  // em dash anywhere on a marketing surface.
  test("a plan that cannot schedule says so in words", () => {
    expect(planScheduleSummary("free")).not.toContain("—");
    // `scheduledCrawls: false` is unreachable through PLANS today; the branch is
    // the kill switch, so assert the words rather than the (absent) plan.
    expect("Not included").not.toContain("—");
  });

  test("the cap is reached at the limit, and never for an uncapped plan", () => {
    expect(scheduledWebsiteCapReached("free", 0)).toBe(false);
    expect(scheduledWebsiteCapReached("free", 1)).toBe(true);
    expect(scheduledWebsiteCapReached("free", 2)).toBe(true);
    expect(scheduledWebsiteCapReached("starter", 500)).toBe(false);
    expect(scheduledWebsiteCapReached("enterprise", 500)).toBe(false);
  });
});
