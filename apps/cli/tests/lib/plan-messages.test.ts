import { describe, expect, test } from "bun:test";

import { PRICING_URL } from "@/constants";
import { teamPlanRequiredMessage } from "@/lib/plan-messages";

describe("teamPlanRequiredMessage", () => {
  test("names the Team plan and links to pricing", () => {
    const message = teamPlanRequiredMessage();
    expect(message).toContain("Team plan");
    expect(message).toContain(PRICING_URL);
  });
});
