// crawl/single-page-site is informational: the health score and every category
// score are identical with and without its finding (pub#1209).

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { crawl, type RuleRunResult } from "@squirrelscan/rules";

import { calculateHealthScore } from "../src/scoring";

const singlePageSiteRule = crawl.singlePageSiteRule;

const check = (status: CheckResult["status"], name: string): CheckResult => ({
  name,
  status,
  message: status,
});

const anchors: Array<RuleRunResult> = [
  {
    meta: {
      id: "crawl/robots-txt",
      name: "robots",
      description: "d",
      category: "crawl",
      scope: "site",
      severity: "error",
      weight: 5,
    },
    checks: [check("pass", "a"), check("warn", "b")],
  },
  {
    meta: {
      id: "core/title",
      name: "title",
      description: "d",
      category: "core",
      scope: "page",
      severity: "warning",
      weight: 4,
    },
    checks: [check("pass", "t"), check("fail", "t2")],
  },
] as RuleRunResult[];

const finding: RuleRunResult = {
  meta: singlePageSiteRule.meta,
  checks: [
    {
      name: "single-page-site",
      status: "info",
      message: "one page",
      value: 4,
      details: { sections: 4 },
    },
  ],
} as RuleRunResult;

const score = (extra: RuleRunResult[]) =>
  calculateHealthScore({ results: new Map([...anchors, ...extra].map((r) => [r.meta.id, r])) });

describe("crawl/single-page-site scoring", () => {
  test("is declared advisory", () => {
    expect(singlePageSiteRule.meta.severity).toBe("info");
    expect(singlePageSiteRule.meta.category).toBe("crawl");
  });

  test("health and category scores are identical with and without the finding", () => {
    const without = score([]);
    const withFinding = score([finding]);
    expect(withFinding.overall).toBe(without.overall);
    expect(withFinding.categories).toEqual(without.categories);
  });

  test("a run that did not fire (no checks) is identical too", () => {
    const empty = { meta: singlePageSiteRule.meta, checks: [] } as unknown as RuleRunResult;
    expect(score([empty])).toEqual(score([]));
  });
});
