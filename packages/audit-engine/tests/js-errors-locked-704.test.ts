// reliability/js-errors is cloud-only (#704): a local or --http audit lists it among the cloud checks that didn't run.

import { describe, expect, test } from "bun:test";

import { loadAllRules } from "@squirrelscan/rules";

import { computeLockedRules } from "../src/publish-meta";

describe("reliability/js-errors locked-rules listing (#704)", () => {
  test("a local audit that skipped it lists it as locked", () => {
    const report = {
      ruleResults: {
        "reliability/js-errors": {
          checks: [
            {
              status: "skipped",
              skipReason:
                "Cloud analysis skipped — run `squirrel auth login` to enable it.",
            },
          ],
        },
      },
    };
    expect(
      computeLockedRules(report, loadAllRules().values()).map((r) => r.id)
    ).toContain("reliability/js-errors");
  });

  test("a run that produced a verdict does not list it", () => {
    const report = {
      ruleResults: {
        "reliability/js-errors": { checks: [{ status: "pass" }] },
      },
    };
    expect(
      computeLockedRules(report, loadAllRules().values()).map((r) => r.id)
    ).not.toContain("reliability/js-errors");
  });
});
