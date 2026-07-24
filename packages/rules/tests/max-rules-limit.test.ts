import { describe, expect, test } from "bun:test";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { loadAllRules } from "../src/loader";

// #982: the API publish schema rejects reports with more rules than
// REPORT_LIMITS.maxRules, so the cap silently strands EVERY cloud/CLI publish
// the moment the catalog grows past it. Fail here, at PR time, with headroom.
describe("rules catalog vs REPORT_LIMITS.maxRules", () => {
  test("catalog count stays below maxRules with headroom", () => {
    const count = loadAllRules().size;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(REPORT_LIMITS.maxRules);
    const headroom = REPORT_LIMITS.maxRules - count;
    expect(headroom).toBeGreaterThanOrEqual(25);
  });
});
