// #1291: a rule that throws is not a failed check. It did not evaluate the page,
// so it is a skipped `<rule>-error` (not evaluated), reported once for the audit
// with the first message and the page count, and the score is the same as if the
// pages had been left unchecked for that rule. Real RuleRunner and real scorer.

import { describe, expect, test } from "bun:test";

import type { CheckResult } from "@squirrelscan/core-contracts";
import { RuleRunner } from "@squirrelscan/rules";
import type { PageData, Rule, RuleNamespace, RuleRunResult } from "@squirrelscan/rules/types";

import { addChecksToTally, calculateHealthScore, emptyTally } from "../src/scoring";

const probe: Rule = {
  meta: { id: "test/probe", name: "Probe", description: "test rule", category: "core", scope: "page", severity: "error", weight: 3 },
  run: (ctx) => {
    if (ctx.page.url.includes("/boom")) throw new Error(`cannot read ${"x".repeat(400)} of null`);
    return { checks: [{ name: "probe", status: "pass", message: "ok" }] };
  },
};

const page = (path: string): PageData => ({
  url: `https://example.com/${path}`,
  html: "<html><head><title>t</title></head><body>x</body></html>",
  statusCode: 200,
  loadTime: 0,
  headers: {},
});

async function audit(paths: string[]): Promise<{ checks: CheckResult[]; results: Map<string, RuleRunResult> }> {
  const ns: RuleNamespace = { name: "test", rules: [probe] };
  const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: ["test/probe"] } }, additionalNamespaces: [ns] });
  const checks: CheckResult[] = [];
  const merged: RuleRunResult = { meta: probe.meta, checks: [] };
  for (const path of paths) {
    const result = await runner.runPageRules(page(path), { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null });
    checks.push(...result.checks);
    merged.checks.push(...(result.ruleResults.get("test/probe")?.checks ?? []));
  }
  const site = await runner.runSiteRules({ baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null });
  checks.push(...site.checks);
  const summary = site.ruleResults.get("test/probe");
  if (summary) merged.checks.push(...summary.checks.filter((c) => c.name === "test/probe-errors"));
  return { checks, results: new Map([["test/probe", merged]]) };
}

const fine = ["a", "b", "c", "d", "e", "f"];
const boom = ["boom1", "boom2", "boom3", "boom4", "boom5"];

describe("a rule that throws is not evaluated, never a fail (#1291)", () => {
  test("throwing on every page of a rule: no fail, skipped rows, one summary with the first message and the count", async () => {
    const out = await audit([...fine, ...boom]);
    const errors = out.checks.filter((c) => c.name === "test/probe-error");
    expect(errors).toHaveLength(boom.length);
    for (const c of errors) expect(c).toMatchObject({ status: "skipped", skipReason: "rule-timed-out", details: { errored: true } });
    expect(errors[0]!.message.startsWith("Rule error:")).toBe(true);
    expect((errors[0]!.details as { error: string }).error.length).toBeLessThan(260);
    expect(out.checks.some((c) => c.status === "fail")).toBe(false);
    const summary = out.checks.filter((c) => c.name === "test/probe-errors");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ status: "info", details: { errored: true, pagesNotChecked: boom.length } });
    expect(summary[0]!.message).toContain("defect in squirrelscan");
  });

  test("the score and the tallies equal an audit where those pages were left out", async () => {
    const withThrows = await audit([...fine, ...boom]);
    const without = await audit(fine);
    const tally = emptyTally();
    addChecksToTally(tally, withThrows.results.get("test/probe")!.checks);
    expect(tally.failed).toBe(0);
    expect(tally.failUnits).toBe(0);
    expect(tally.passed).toBe(fine.length);
    expect(calculateHealthScore({ results: withThrows.results }).overall).toBe(calculateHealthScore({ results: without.results }).overall);
  });

  test("a second audit on the same runner starts its own count", async () => {
    const ns: RuleNamespace = { name: "test", rules: [probe] };
    const runner = new RuleRunner({ config: { rule_options: {}, rules: { enable: ["test/probe"] } }, additionalNamespaces: [ns] });
    const site = { baseUrl: "https://example.com", pages: [], robotsTxt: null, sitemaps: null };
    await runner.runPageRules(page("boom1"), site);
    await runner.runSiteRules(site);
    const again = await runner.runPageRules(page("boom2"), site);
    const first = again.checks.find((c) => c.name === "test/probe-error");
    expect(first?.details).toMatchObject({ pages: 1, error: expect.any(String) });
  });
});
