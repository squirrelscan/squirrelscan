// content/terminology-consistency scoring density (squirrelscan/repo#1368): one site check, weight 2,
// at most 8 items. Scored by the real category scorer, a worst-case failure must cost the content
// category no more than a failure from a per-page content rule, so it cannot dominate the category.

import type { CheckResult } from "@squirrelscan/core-contracts";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import { loadAllRules } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import { calculateHealthScore } from "../src/scoring";

const contentRules = [...loadAllRules().values()].filter(
  (r) => r.meta.category === "content"
);

function contentScore(override?: {
  ruleId: string;
  check: CheckResult;
}): number {
  const results = new Map<string, RuleRunResult>();
  for (const rule of contentRules) {
    const check: CheckResult =
      override?.ruleId === rule.meta.id
        ? override.check
        : { name: rule.meta.id.split("/")[1]!, status: "pass", message: "ok" };
    results.set(rule.meta.id, { meta: rule.meta, checks: [check] });
  }
  const category = calculateHealthScore({ results }).categories.find(
    (c) => c.category === "content"
  );
  if (!category) throw new Error("no content category score");
  return category.score;
}

describe("content/terminology-consistency: scoring density", () => {
  test("a worst-case failure costs no more than a failure from a heavier per-page content rule", () => {
    const clean = contentScore();
    const fail = contentScore({
      ruleId: "content/terminology-consistency",
      check: {
        name: "terminology-consistency",
        status: "fail",
        message: "100 page(s) use different words for the same thing",
        value: 100,
      },
    });
    const stale = contentScore({
      ruleId: "content/stale-dated-copy",
      check: {
        name: "stale-dated-copy",
        status: "fail",
        message: "1 claim is stale",
      },
    });
    expect(fail).toBeLessThan(clean);
    expect(clean - fail).toBeLessThanOrEqual(clean - stale);
    expect(clean - fail).toBeLessThan(5);
  });
});
