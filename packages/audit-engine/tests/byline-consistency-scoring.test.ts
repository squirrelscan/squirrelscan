// eeat/byline-consistency scoring density (squirrelscan/repo#1364): one site check, weight 2, at most 4
// items. Scored by the real category scorer, a worst-case failure of this rule must cost the E-E-A-T
// category no more than either per-page rule it can overlap at its own worst (a warning), so it cannot dominate the
// category score.

import { describe, expect, test } from "bun:test";

import type { CheckItem, CheckResult } from "@squirrelscan/core-contracts";
import { loadAllRules } from "@squirrelscan/rules";
import type { RuleRunResult } from "@squirrelscan/rules/types";

import { calculateHealthScore } from "../src/scoring";

const eeatRules = [...loadAllRules().values()].filter((r) => r.meta.category === "eeat");

function passing(): Map<string, RuleRunResult> {
  const results = new Map<string, RuleRunResult>();
  for (const rule of eeatRules) {
    results.set(rule.meta.id, {
      meta: rule.meta,
      checks: [{ name: rule.meta.id.split("/")[1]!, status: "pass", message: "ok" }],
    });
  }
  return results;
}

function eeatScore(results: Map<string, RuleRunResult>): number {
  const category = calculateHealthScore({ results }).categories.find((c) => c.category === "eeat");
  if (!category) throw new Error("no eeat category score");
  return category.score;
}

function withCheck(ruleId: string, check: CheckResult): Map<string, RuleRunResult> {
  const results = passing();
  const prior = results.get(ruleId);
  if (!prior) throw new Error(`${ruleId} is not an eeat rule`);
  results.set(ruleId, { ...prior, checks: [check] });
  return results;
}

/** The most this rule can emit: a fail with the item cap reached, each item at the url cap. */
const items: CheckItem[] = Array.from({ length: 4 }, (_, i) => ({
  id: `type${i}:author`,
  label: `10 of 40 type${i} page(s) have no visible author byline`,
  sourcePages: Array.from({ length: 10 }, (_, j) => `https://example.com/t${i}/p${j}`),
}));

describe("eeat/byline-consistency: scoring density", () => {
  test("a worst-case failure costs E-E-A-T no more than a warning from either per-page E-E-A-T rule", () => {
    const clean = eeatScore(passing());
    const byline = eeatScore(
      withCheck("eeat/byline-consistency", {
        name: "byline-consistency",
        status: "fail",
        message: "100 of 400 page(s) break the site's own byline convention",
        value: 100,
        items,
      }),
    );
    const author = eeatScore(
      withCheck("eeat/author-byline", {
        name: "author-byline",
        status: "warn",
        message: "Only 20% of content pages have author attribution",
      }),
    );
    const dates = eeatScore(
      withCheck("eeat/content-dates", {
        name: "date-published",
        status: "warn",
        message: "Only 20% of content has datePublished",
      }),
    );

    expect(byline).toBeLessThan(clean);
    expect(clean - byline).toBeLessThan(clean - author);
    expect(clean - byline).toBeLessThanOrEqual(clean - dates);
    // And it stays a light finding: under 5 of 100 points on its own.
    expect(clean - byline).toBeLessThan(5);
  });
});
