// pub#970: a security rule abandoned for its time budget did not check those
// pages, so `--fail-on` must still see it, while the health score stays as if the
// page were left unchecked (a slow host must not lower it, pub#960). Driven with
// the real RuleRunner and the real scorer; a non-security rule is the control.

import type { RuleCategory } from "@squirrelscan/core-contracts";
import type { PageData, Rule, RuleRunResult } from "@squirrelscan/rules/types";

import { calculateHealthScore } from "@squirrelscan/audit-engine";
import { RuleRunner, type RuleNamespace } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/types";

import {
  evaluateFailOn,
  formatFailOnSummary,
  parseFailOn,
} from "../../src/audit/fail-on";

const BUDGET_MS = 50;

function slowRule(id: string, category: RuleCategory): Rule {
  return {
    meta: {
      id,
      name: id,
      description: "test",
      category,
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    run: (ctx) => {
      if (ctx.page.url.endsWith("/slow")) {
        const until = performance.now() + BUDGET_MS * 4;
        while (performance.now() < until) {
          // spin past the budget
        }
      }
      return { checks: [{ name: id, status: "pass", message: "ok" }] };
    },
  };
}

const page = (path: string): PageData => ({
  url: `https://example.com/${path}`,
  html: "<html><head><title>t</title></head><body>x</body></html>",
  statusCode: 200,
  loadTime: 0,
  headers: {},
});

/** One audit through the real runner, scored, as the report shape the gate reads. */
async function report(rule: Rule, paths: string[]): Promise<AuditReport> {
  const ns: RuleNamespace = { name: "test", rules: [rule] };
  const runner = new RuleRunner({
    config: { rule_options: {}, rules: { enable: [rule.meta.id] } },
    additionalNamespaces: [ns],
    ruleTimeBudgetMs: BUDGET_MS,
  });
  const merged: RuleRunResult = { meta: rule.meta, checks: [] };
  const site = {
    baseUrl: "https://example.com",
    pages: [],
    robotsTxt: null,
    sitemaps: null,
  };
  for (const path of paths) {
    const result = await runner.runPageRules(page(path), site);
    merged.checks.push(...(result.ruleResults.get(rule.meta.id)?.checks ?? []));
  }
  const siteResult = await runner.runSiteRules(site);
  const summary = siteResult.ruleResults.get(rule.meta.id);
  if (summary) merged.checks.push(...summary.checks);
  const healthScore = calculateHealthScore({
    results: new Map([[rule.meta.id, merged]]),
  });
  return {
    healthScore,
    failed: healthScore.errorCount ?? 0,
    warnings: healthScore.warningCount ?? 0,
    ruleResults: { [rule.meta.id]: merged },
  } as unknown as AuditReport;
}

const gate = (specs: string[], r: AuditReport) =>
  evaluateFailOn(parseFailOn(specs).conditions, r);
const fast = ["a", "b", "c"];

describe("a timed-out security rule stays visible to --fail-on (pub#970)", () => {
  test("severity>=warning and warnings>=1 trip; errors and score do not", async () => {
    const timedOut = await report(slowRule("security/test-slow", "security"), [
      "slow",
      ...fast,
    ]);
    const unchecked = await report(
      slowRule("security/test-slow", "security"),
      fast
    );

    // The score is the one of the audit with that page left unchecked.
    expect(timedOut.healthScore?.overall).toBe(unchecked.healthScore?.overall);
    expect(timedOut.healthScore?.warningCount ?? 0).toBe(0);

    const warnings = gate(["warnings>=1"], timedOut);
    expect(warnings.trips).toHaveLength(1);
    expect(warnings.trips[0]!.actual).toBe(
      "1 warning-severity findings (incl. 1 timed-out security rule)"
    );
    expect(gate(["severity>=warning"], timedOut).trips).toHaveLength(1);
    expect(gate(["errors>=1"], timedOut).trips).toHaveLength(0);
    expect(gate(["score<100"], timedOut).trips).toHaveLength(
      gate(["score<100"], unchecked).trips.length
    );

    // The summary names the rule and the page count.
    const lines = formatFailOnSummary(gate(["warnings>=1"], timedOut)).join(
      "\n"
    );
    expect(lines).toContain(
      "security/test-slow timed out on 1 page and did not check them"
    );
    expect(lines).toContain("not in the score");

    // Control: the same audit with nothing timed out passes the gate.
    expect(
      gate(["warnings>=1", "severity>=warning"], unchecked).trips
    ).toHaveLength(0);
  }, 30_000);

  test("a timeout on several pages is still one warning, with the page count", async () => {
    const r = await report(slowRule("security/test-slow", "security"), [
      "slow",
      "x/slow",
      ...fast,
    ]);
    const ev = gate(["warnings>=1"], r);
    expect(ev.trips[0]!.actual).toContain("incl. 1 timed-out security rule");
    expect(ev.notes[0]).toContain("timed out on 2 pages");
  }, 30_000);

  test("a non-security rule keeps the #960 behaviour: no gate trip", async () => {
    const r = await report(slowRule("content/test-slow", "content"), [
      "slow",
      ...fast,
    ]);
    expect(
      gate(["warnings>=1", "severity>=warning", "errors>=1"], r).trips
    ).toHaveLength(0);
    expect(gate(["warnings>=1"], r).notes).toEqual([]);
  }, 30_000);
});

describe("a rule that threw on every page stays visible to --fail-on (#1291)", () => {
  const throwing = (id: string, category: RuleCategory): Rule => ({
    meta: {
      id,
      name: id,
      description: "test",
      category,
      scope: "page",
      severity: "warning",
      weight: 1,
    },
    run: () => {
      throw new Error("boom");
    },
  });

  for (const category of ["core", "security"] as const) {
    test(`${category}: scores as unchecked, warnings and severity gates trip, errors and score do not`, async () => {
      const broken = await report(
        throwing(`${category}/test-broken`, category),
        fast
      );
      expect(broken.healthScore?.warningCount ?? 0).toBe(0);
      const warnings = gate(["warnings>=1"], broken);
      expect(warnings.trips).toHaveLength(1);
      expect(warnings.trips[0]!.actual).toBe(
        "1 warning-severity findings (incl. 1 rule that hit an internal error)"
      );
      expect(gate(["severity>=warning"], broken).trips).toHaveLength(1);
      expect(gate(["errors>=1"], broken).trips).toHaveLength(0);
      const lines = formatFailOnSummary(warnings).join("\n");
      expect(lines).toContain(
        `${category}/test-broken failed with an internal error on 3 pages and did not check them`
      );
    });
  }
});
