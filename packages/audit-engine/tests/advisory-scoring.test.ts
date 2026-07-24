// Advisory scoring — warn checks in severity-"info" rules are recommendations:
// they surface in the report issues list but must be score-neutral. Fails in
// info rules still count (e.g. a fallback-masked llms.txt is actively
// misleading, not merely absent).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleMeta, RuleRunResult } from "@squirrelscan/rules";

import { calculateHealthScore } from "../src/scoring";

function meta(over: Partial<RuleMeta>): RuleMeta {
  return {
    id: "ax/example",
    name: "Example",
    description: "Example rule",
    category: "ax",
    scope: "site",
    severity: "info",
    weight: 1,
    ...over,
  };
}

function check(status: CheckResult["status"], name = "example-check"): CheckResult {
  return { name, status, message: `status ${status}`, pageUrl: "https://example.com/" };
}

function score(rules: Array<{ meta: RuleMeta; checks: CheckResult[] }>) {
  const map = new Map<string, RuleRunResult>(rules.map((r) => [r.meta.id, r]));
  return calculateHealthScore({ results: map });
}

// A scoreable warning-severity rule to anchor the category so it never
// collapses to "no scoreable rules".
const ANCHOR = {
  meta: meta({ id: "ax/anchor", name: "Anchor", severity: "warning", weight: 2 }),
  checks: [check("pass", "anchor-check")],
};

describe("advisory scoring (severity info rules)", () => {
  test("warn in an info rule does not move the category score", () => {
    const withoutRec = score([ANCHOR]);
    const withRec = score([
      ANCHOR,
      { meta: meta({ id: "ax/rec", name: "Rec" }), checks: [check("warn")] },
    ]);
    const ax = (s: ReturnType<typeof score>) => s.categories.find((c) => c.category === "ax");
    expect(ax(withRec)?.score).toBe(ax(withoutRec)?.score);
    // ...and it is not counted as a warning in the score summary.
    expect(ax(withRec)?.warnings).toBe(0);
  });

  test("warn in a warning rule still lowers the score", () => {
    const clean = score([ANCHOR]);
    const warned = score([
      ANCHOR,
      { meta: meta({ id: "ax/w", name: "W", severity: "warning" }), checks: [check("warn")] },
    ]);
    const ax = (s: ReturnType<typeof score>) => s.categories.find((c) => c.category === "ax");
    expect(ax(warned)!.score).toBeLessThan(ax(clean)!.score);
    expect(ax(warned)?.warnings).toBe(1);
  });

  test("fail in an info rule still counts against the score", () => {
    const clean = score([ANCHOR]);
    const failed = score([
      ANCHOR,
      { meta: meta({ id: "ax/f", name: "F" }), checks: [check("fail")] },
    ]);
    const ax = (s: ReturnType<typeof score>) => s.categories.find((c) => c.category === "ax");
    expect(ax(failed)!.score).toBeLessThan(ax(clean)!.score);
  });

  test("info rule with only warn checks is excluded from weight entirely", () => {
    // If the advisory warn were merely treated as 0.5 credit, adding the rule
    // would shift the weighted average; excluded-from-weight means identical.
    const base = score([ANCHOR]);
    const withOnlyRec = score([
      ANCHOR,
      {
        meta: meta({ id: "ax/only-rec", name: "OnlyRec", weight: 9 }),
        checks: [check("warn"), check("warn", "other-check")],
      },
    ]);
    expect(withOnlyRec.categories.find((c) => c.category === "ax")?.score).toBe(
      base.categories.find((c) => c.category === "ax")?.score,
    );
  });
});
