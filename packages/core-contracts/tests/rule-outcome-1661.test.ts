// The typed rule outcome and the one table behind it (#1661).

import { describe, expect, test } from "bun:test";

import * as contracts from "../src/index";
import * as ignore from "../src/ignore";
import * as resolution from "../src/resolution";
import {
  classifyRuleOutcome,
  RULE_OUTCOMES,
  SKIP_REASON_CLASSES,
  skipReasonClass,
  type RuleOutcome,
} from "../src/rule-outcome";

/** Every exported constant named `*_SKIP_REASON`: the coded reasons the codebase writes by name. */
function codedReasonConstants(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const mod of [contracts, ignore, resolution] as Array<Record<string, unknown>>) {
    for (const [name, value] of Object.entries(mod)) {
      if (/_SKIP_REASON$/.test(name) && typeof value === "string") out.push([name, value]);
    }
  }
  return [...new Map(out).entries()];
}

describe("every coded skip reason has an outcome", () => {
  test("the constants are found (so the checks below are not vacuous)", () => {
    expect(codedReasonConstants().length).toBeGreaterThanOrEqual(14);
  });

  for (const [name, reason] of codedReasonConstants()) {
    test(`${name} is in the table`, () => {
      expect(skipReasonClass(reason), `add "${reason}" to SKIP_REASON_CLASSES in rule-outcome.ts`).toBeDefined();
    });
  }

  test("the table has no entry that is not a named constant", () => {
    const named = new Set(codedReasonConstants().map(([, reason]) => reason));
    for (const reason of Object.keys(SKIP_REASON_CLASSES)) {
      expect(named.has(reason), `"${reason}" has no exported *_SKIP_REASON constant`).toBe(true);
    }
  });
});

describe("classifyRuleOutcome", () => {
  const skipped = (skipReason?: string, details?: Record<string, unknown>) => ({ status: "skipped", skipReason, details });
  const table: Array<[string, { status: string; skipReason?: string; details?: Record<string, unknown> }, RuleOutcome]> = [
    ["a pass ran", { status: "pass" }, "ran"],
    ["a warn ran", { status: "warn" }, "ran"],
    ["a fail ran", { status: "fail" }, "ran"],
    ["an info ran", { status: "info" }, "ran"],
    ["a pass with a stray skipReason still ran", { status: "pass", skipReason: "noindex" }, "ran"],
    ["the noindex gate", skipped("noindex"), "not_applicable"],
    ["the page-type gate", skipped("page-type"), "not_applicable"],
    ["a check with nothing to look at", skipped("not-applicable"), "not_applicable"],
    ["a rule that timed out", skipped("rule-timed-out"), "timed_out"],
    ["a rule that timed out with details but no error", skipped("rule-timed-out", { pages: 3, errored: false }), "timed_out"],
    ["a rule that threw", skipped("rule-timed-out", { errored: true }), "errored"],
    ["an unreadable page", skipped("unread-page"), "coverage_gap"],
    ["a scan cut at a work cap", skipped("scan-truncated"), "coverage_gap"],
    ["TLS not checked", skipped("tls-certificate-not-checked"), "coverage_gap"],
    ["external links off", skipped("external-links-not-checked"), "coverage_gap"],
    ["external links over the cap", skipped("external-links-over-cap"), "coverage_gap"],
    ["a targeted run", skipped("targeted-run"), "coverage_gap"],
    ["a capped crawl", skipped("Crawl capped before the frontier was exhausted"), "coverage_gap"],
    ["a waived page", skipped("ignored"), "disabled"],
    ["a private target", skipped("private-target"), "disabled"],
    ["free text is not applicable", skipped("Parse error"), "not_applicable"],
    ["no reason is not applicable", skipped(undefined), "not_applicable"],
    ["a prototype key is not a reason", skipped("__proto__"), "not_applicable"],
    ["constructor is not a reason", skipped("constructor"), "not_applicable"],
    ["errored only counts on a timed-out skip", skipped("noindex", { errored: true }), "not_applicable"],
  ];
  for (const [name, check, expected] of table) {
    test(`${name}: ${expected}`, () => {
      expect(classifyRuleOutcome(check)).toBe(expected);
    });
  }

  test("every outcome is reachable and listed", () => {
    const reached = new Set(table.map((r) => r[2]));
    expect([...reached].sort()).toEqual([...RULE_OUTCOMES].sort());
  });

  test("an errored rule and a timed-out rule are told apart", () => {
    expect(classifyRuleOutcome(skipped("rule-timed-out", { errored: true }))).not.toBe(
      classifyRuleOutcome(skipped("rule-timed-out")),
    );
  });
});
