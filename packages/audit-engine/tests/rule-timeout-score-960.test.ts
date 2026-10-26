// pub#960: a rule abandoned for its time budget is NOT a failed check. It did not
// finish on that page, so the page is not evaluated for it: no fail in the
// tallies and no change to the health score, as if that page were left unchecked
// for that rule. Runs the real RuleRunner and the real scorer.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { RuleRunner } from "@squirrelscan/rules";
import type { PageData, Rule, RuleNamespace, RuleRunResult } from "@squirrelscan/rules/types";

import { addChecksToTally, calculateHealthScore, emptyTally } from "../src/scoring";

const BUDGET_MS = 50;

/** Passes, except on a page whose url ends in `/slow`, which it spins on past the budget. */
const probe: Rule = {
  meta: {
    id: "test/probe",
    name: "test/probe",
    description: "test rule",
    category: "core",
    scope: "page",
    severity: "warning",
    weight: 1,
  },
  run: (ctx) => {
    if (ctx.page.url.endsWith("/slow")) {
      const until = performance.now() + BUDGET_MS * 4;
      while (performance.now() < until) {
        // spin
      }
    }
    return { checks: [{ name: "probe", status: "pass", message: "ok" }] };
  },
};

function page(path: string): PageData {
  return {
    url: `https://example.com/${path}`,
    html: "<html><head><title>t</title></head><body>x</body></html>",
    statusCode: 200,
    loadTime: 0,
    headers: {},
  };
}

/** One audit: every page through a fresh runner, results merged per rule. */
async function audit(paths: string[]): Promise<{ checks: CheckResult[]; results: Map<string, RuleRunResult> }> {
  const ns: RuleNamespace = { name: "test", rules: [probe] };
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: ["test/probe"] } },
    additionalNamespaces: [ns],
    ruleTimeBudgetMs: BUDGET_MS,
  });
  const checks: CheckResult[] = [];
  const merged: RuleRunResult = { meta: probe.meta, checks: [] };
  for (const path of paths) {
    const result = await runner.runPageRules(page(path), {
      baseUrl: "https://example.com",
      pages: [],
      robotsTxt: null,
      sitemaps: null,
    });
    checks.push(...result.checks);
    merged.checks.push(...(result.ruleResults.get("test/probe")?.checks ?? []));
  }
  const site = await runner.runSiteRules({ baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null });
  checks.push(...site.checks);
  return { checks, results: new Map([["test/probe", merged]]) };
}

const fast = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];

describe("a timed-out rule is not evaluated, never a fail (pub#960)", () => {
  for (const slowAt of ["first", "later"] as const) {
    test(`timing out on the ${slowAt} page: skipped, no fail tally, score unchanged`, async () => {
      const paths = slowAt === "first" ? ["slow", ...fast] : [...fast, "slow"];
      const withTimeout = await audit(paths);
      const unchecked = await audit(fast);

      const timeouts = withTimeout.checks.filter((c) => c.name === "test/probe-error");
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({ status: "skipped", skipReason: "rule-timed-out" });
      expect(timeouts[0]!.details).toMatchObject({ timedOut: true, budgetMs: BUDGET_MS, pages: 1 });
      // The info row that says the page was not checked is still there.
      expect(withTimeout.checks.find((c) => c.name === "test/probe-timeouts")).toMatchObject({
        status: "info",
        details: { pagesNotChecked: 1 },
      });
      expect(withTimeout.checks.some((c) => c.status === "fail")).toBe(false);

      const tally = emptyTally();
      addChecksToTally(tally, withTimeout.results.get("test/probe")!.checks);
      expect(tally.failed).toBe(0);
      expect(tally.failUnits).toBe(0);
      expect(tally.passed).toBe(fast.length);

      const a = calculateHealthScore({ results: withTimeout.results });
      const b = calculateHealthScore({ results: unchecked.results });
      expect(a.overall).toBe(b.overall);
    }, 30_000);
  }
});
