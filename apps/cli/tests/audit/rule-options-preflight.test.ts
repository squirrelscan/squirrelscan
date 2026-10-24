// pub#510: `squirrel audit` checks `[rule_options]` before the crawl. A value
// of the wrong type on a rule the audit runs stops it; everything that changes
// nothing only warns.

import { describe, expect, test } from "bun:test";

import { preflightRuleOptions } from "@/audit/rule-options-preflight";

const ALL = { enable: ["*"], disable: [] };

describe("preflightRuleOptions", () => {
  test("a clean config has nothing to say", () => {
    expect(
      preflightRuleOptions({ "core/meta-title": { min_length: 20 } }, ALL)
    ).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("a wrong type on a running rule is an error naming the table and the key", () => {
    const { errors, warnings } = preflightRuleOptions(
      { "core/meta-title": { min_length: "thirty" } },
      ALL
    );
    expect(warnings).toEqual([]);
    expect(errors).toEqual([
      '[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string',
    ]);
  });

  test("unknown rule ids, unknown options and a non-boolean enabled only warn", () => {
    const { errors, warnings } = preflightRuleOptions(
      {
        "performance/ttfb": { warn_threshold: 300 },
        "core/meta-description": { no_such_option: 5 },
        "core/meta-title": { enabled: "false" },
      },
      ALL
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toStartWith(
      '[rule_options."performance/ttfb"]: no rule has this id'
    );
    expect(warnings[1]).toStartWith(
      '[rule_options."core/meta-description"] no_such_option:'
    );
    expect(warnings[2]).toStartWith(
      '[rule_options."core/meta-title"] enabled:'
    );
  });

  test("a wrong type on a rule this audit does not run only warns", () => {
    const options = { "core/meta-title": { min_length: "thirty" } };
    for (const rules of [
      { enable: ["*"], disable: ["core/meta-title"] },
      { enable: ["perf/*"], disable: [] },
    ]) {
      const { errors, warnings } = preflightRuleOptions(options, rules);
      expect(errors).toEqual([]);
      expect(warnings).toEqual([
        '[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string (the rule does not run in this audit)',
      ]);
    }
  });

  test("enabled = true turns a disabled rule back on, so its bad value stops the audit", () => {
    const { errors } = preflightRuleOptions(
      { "core/meta-title": { enabled: true, min_length: "thirty" } },
      { enable: ["*"], disable: ["core/*"] }
    );
    expect(errors).toHaveLength(1);
  });

  test("an opt-in gap rule validates only when explicitly selected", () => {
    const options = { "gaps/keywords": { country: 1 } };
    expect(preflightRuleOptions(options, ALL)).toMatchObject({
      errors: [],
      warnings: [
        expect.stringContaining("the rule does not run in this audit"),
      ],
    });
    expect(
      preflightRuleOptions(options, {
        enable: ["gaps/keywords"],
        disable: [],
      }).errors
    ).toEqual([
      '[rule_options."gaps/keywords"] country: Invalid input: expected string, received number',
    ]);
  });
});
