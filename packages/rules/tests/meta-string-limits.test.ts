import { describe, expect, test } from "bun:test";
import { REPORT_LIMITS } from "@squirrelscan/core-contracts/limits";
import { loadAllRules } from "../src/loader";

// Every rule's STATIC meta is publish-payload: the API publish schema caps
// id/name/subcategory at maxShortString, description at maxMediumString and
// solution at maxLongString. A rule shipping past a cap 400s EVERY publish in
// prod while all CI stays green (#988: ax/ai-crawlers solution vs the old
// medium cap; same class as #982). Static meta is fully checkable here.
describe("rule meta strings vs REPORT_LIMITS publish caps", () => {
  const rules = [...loadAllRules().values()];

  test("catalog loaded", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  test.each(rules.map((r) => [r.meta.id, r.meta] as const))(
    "%s meta fits publish caps",
    (_id, meta) => {
      expect(meta.id.length).toBeLessThanOrEqual(REPORT_LIMITS.maxShortString);
      expect(meta.name.length).toBeLessThanOrEqual(REPORT_LIMITS.maxShortString);
      expect(meta.description.length).toBeLessThanOrEqual(REPORT_LIMITS.maxMediumString);
      if (meta.subcategory) {
        expect(meta.subcategory.length).toBeLessThanOrEqual(REPORT_LIMITS.maxShortString);
      }
      if (meta.solution) {
        expect(meta.solution.length).toBeLessThanOrEqual(REPORT_LIMITS.maxLongString);
      }
    },
  );
});
