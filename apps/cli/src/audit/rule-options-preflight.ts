// `[rule_options]` preflight for `squirrel audit` (pub#510). A value of the
// wrong type used to fail the audit only when its rule ran, after the crawl had
// started and the run was registered, with a bare zod issue list. Checked here
// before any request, an option of a rule this audit runs stops it naming the
// table and the key. Everything that changes nothing (an unknown rule id or
// option, a non-boolean `enabled`, a bad value on a rule this audit skips) is
// a warning.

import {
  checkIgnoreEntries,
  checkRuleOptions,
  filterRules,
  loadAllRules,
  type IgnoreEntry,
} from "@squirrelscan/rules";

export interface RuleOptionsPreflight {
  /** Problems that would fail the audit: print and stop. */
  errors: string[];
  /** Problems that change nothing: print and carry on. */
  warnings: string[];
}

export function preflightRuleOptions(
  ruleOptions: Record<string, Record<string, unknown>>,
  rules: { enable: string[]; disable: string[] },
  ignore?: readonly IgnoreEntry[]
): RuleOptionsPreflight {
  // `[[ignore]]` problems (#1262) change nothing at audit time (the entry or matcher
  // is skipped), so they only warn here; `squirrel config validate` fails on them.
  const problems = [
    ...checkRuleOptions(ruleOptions),
    ...checkIgnoreEntries(ignore),
  ];
  const result: RuleOptionsPreflight = { errors: [], warnings: [] };
  if (problems.length === 0) return result;

  // The same selection the runner makes, so a rule this audit skips cannot
  // stop it.
  const registry = loadAllRules({ includeOptIn: true });
  const running = new Set(
    filterRules(
      [...registry.keys()],
      rules.enable,
      rules.disable,
      ruleOptions as Record<string, { enabled?: boolean }>,
      registry
    )
  );
  for (const problem of problems) {
    if (problem.kind !== "invalid-value") {
      result.warnings.push(problem.message);
    } else if (running.has(problem.ruleId)) {
      result.errors.push(problem.message);
    } else {
      result.warnings.push(
        `${problem.message} (the rule does not run in this audit)`
      );
    }
  }
  return result;
}
