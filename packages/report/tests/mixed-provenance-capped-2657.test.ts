// squirrelscan/repo#2657 — the "fixed on all pages checked this run" note on a
// capped published report. The capper drops per-page pass rows, so the fresh
// passes the note needs are only in the report's `checkTallies`. Without them
// the note silently vanished; with them it fires, minus the clean-page count a
// per-check-name tally cannot give.

import { describe, expect, test } from "bun:test";
import type { CheckTallies, ReportRuleResult } from "@squirrelscan/core-contracts";

import { ruleMixedProvenanceNote } from "../src/coverage";
import { groupIssuesByCategory } from "../src/grouping";

const RULE = "legal/cookie-consent";

function rule(checks: ReportRuleResult["checks"]): Record<string, ReportRuleResult> {
  return {
    [RULE]: {
      meta: {
        id: RULE,
        name: RULE,
        description: "",
        category: "legal",
        scope: "page",
        severity: "warning",
        weight: 5,
      },
      checks,
    },
  };
}

/** A capped rule body after the merge: no pass rows, three carried pages. */
const carriedOnly = rule(
  [0, 1, 2].map((i) => ({
    name: "cookie-consent-missing",
    status: "warn" as const,
    message: "no consent banner",
    pageUrl: `https://e.com/carried-${i}`,
    provenance: "carried" as const,
    lastSeenAt: 1,
  })),
);

describe("mixed-provenance note on a capped report (repo#2657)", () => {
  test("fires from the tallies when the rows hold no passes", () => {
    const tallies: CheckTallies = { [RULE]: { "cookie-consent-missing": { passed: 75 } } };
    const grouped = groupIssuesByCategory(carriedOnly, tallies);
    expect(grouped[0]!.rules[0]!.mixedProvenanceNote).toBe(
      "Fixed on all pages checked this run; 3 pages pending re-check.",
    );
  });

  test("stays silent without tallies, as before", () => {
    expect(groupIssuesByCategory(carriedOnly)[0]!.rules[0]!.mixedProvenanceNote).toBeUndefined();
  });

  test("stays silent when the tallies count a fresh issue anywhere in the rule", () => {
    const checks = carriedOnly[RULE]!.checks;
    expect(
      ruleMixedProvenanceNote(checks, { "cookie-consent-missing": { passed: 70, warnings: 5 } }),
    ).toBeUndefined();
    expect(
      ruleMixedProvenanceNote(checks, {
        "cookie-consent-missing": { passed: 70 },
        "cookie-consent-string": { failed: 1 },
      }),
    ).toBeUndefined();
  });

  test("stays silent when nothing passed this run", () => {
    expect(
      ruleMixedProvenanceNote(carriedOnly[RULE]!.checks, { "cookie-consent-missing": { skipped: 9 } }),
    ).toBeUndefined();
  });

  test("an uncapped report's pass rows win: the clean-page count stays", () => {
    const checks: ReportRuleResult["checks"] = [
      ...carriedOnly[RULE]!.checks,
      { name: "cookie-consent-missing", status: "pass", message: "ok", pageUrl: "https://e.com/a" },
    ];
    expect(ruleMixedProvenanceNote(checks, { "cookie-consent-missing": { passed: 1 } })).toBe(
      "Fixed on all 1 page checked this run; 3 pages pending re-check.",
    );
  });
});
