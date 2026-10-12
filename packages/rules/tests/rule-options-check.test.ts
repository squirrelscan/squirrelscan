// pub#510: `[rule_options]` tables checked against the rules they name. An
// unknown rule id or option name used to change nothing without a word, and a
// value of the wrong type failed the whole audit with a bare zod issue list.

import { describe, expect, test } from "bun:test";

import { checkRuleOptions, ruleOptionsTable } from "../src/rule-options-check";
import { RuleRunner } from "../src/runner";

describe("checkRuleOptions", () => {
  test("declared options of the right type, and a boolean enabled, are fine", () => {
    expect(
      checkRuleOptions({
        "core/meta-title": { min_length: 20, max_length: 70, enabled: true },
        "content/hidden-text": { a11y_classes: ["u-hide"], enabled: false },
      }),
    ).toEqual([]);
  });

  test("a table naming no rule is reported, with a same-name rule as the hint", () => {
    const [problem, ...rest] = checkRuleOptions({ "performance/ttfb": { warn_threshold: 300 } });
    expect(rest).toEqual([]);
    expect(problem?.kind).toBe("unknown-rule");
    expect(problem?.key).toBeNull();
    expect(problem?.message).toBe(
      '[rule_options."performance/ttfb"]: no rule has this id, so the table changes nothing (did you mean "perf/ttfb"?)',
    );
  });

  test("an unknown id with no similar rule carries no hint", () => {
    const [problem] = checkRuleOptions({ "core/no-such-rule-anywhere": {} });
    expect(problem?.kind).toBe("unknown-rule");
    expect(problem?.message).toBe(
      '[rule_options."core/no-such-rule-anywhere"]: no rule has this id, so the table changes nothing',
    );
  });

  test("an option the rule does not declare is reported with the rule's options", () => {
    const [problem, ...rest] = checkRuleOptions({ "core/meta-description": { no_such_option: 5 } });
    expect(rest).toEqual([]);
    expect(problem?.kind).toBe("unknown-option");
    expect(problem?.key).toBe("no_such_option");
    expect(problem?.message).toStartWith(
      '[rule_options."core/meta-description"] no_such_option: not an option of core/meta-description, so it changes nothing (options: ',
    );
    expect(problem?.message).toContain("min_length");
  });

  test("an option on a rule that takes none says so", () => {
    const [problem] = checkRuleOptions({ "a11y/skip-link": { min_links: 2 } });
    expect(problem?.kind).toBe("unknown-option");
    expect(problem?.message).toEndWith("(this rule takes no options)");
  });

  test("a value of the wrong type names the table and the option", () => {
    const [problem, ...rest] = checkRuleOptions({ "core/meta-title": { min_length: "thirty" } });
    expect(rest).toEqual([]);
    expect(problem?.kind).toBe("invalid-value");
    expect(problem?.key).toBe("min_length");
    expect(problem?.message).toBe(
      '[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string',
    );
  });

  test("a wrong element inside a list names its index", () => {
    const [problem] = checkRuleOptions({ "content/hidden-text": { a11y_classes: ["ok", 7] } });
    expect(problem?.kind).toBe("invalid-value");
    expect(problem?.key).toBe("a11y_classes");
    expect(problem?.message).toStartWith('[rule_options."content/hidden-text"] a11y_classes.1: ');
  });

  test("a non-boolean enabled is reported as changing nothing", () => {
    const [problem, ...rest] = checkRuleOptions({ "core/meta-title": { enabled: "false" } });
    expect(rest).toEqual([]);
    expect(problem?.kind).toBe("ignored-value");
    expect(problem?.message).toBe(
      '[rule_options."core/meta-title"] enabled: must be true or false, so it changes nothing',
    );
  });

  test("a disabled rule is still known: the CLI reads the gaps/* options", () => {
    expect(checkRuleOptions({ "gaps/keywords": { country: "AU", competitors: ["a.com"] } })).toEqual(
      [],
    );
  });

  test("problems come back in table order", () => {
    const problems = checkRuleOptions({
      "core/meta-title": { min_length: "thirty" },
      "performance/ttfb": {},
      "core/meta-description": { no_such_option: 5 },
    });
    expect(problems.map((p) => p.ruleId)).toEqual([
      "core/meta-title",
      "performance/ttfb",
      "core/meta-description",
    ]);
  });

  test("the table header is the TOML a user wrote", () => {
    expect(ruleOptionsTable("core/meta-title")).toBe('[rule_options."core/meta-title"]');
  });
});

describe("RuleRunner with a wrong-typed option", () => {
  test("the error names the table and the option, not a bare zod issue list", () => {
    const runner = new RuleRunner({
      config: {
        rules: { enable: ["core/meta-title"], disable: [] },
        rule_options: { "core/meta-title": { min_length: "thirty" } },
      },
    });
    expect(() => runner.pageRuleSignature()).toThrow(
      '[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string',
    );
  });
});
