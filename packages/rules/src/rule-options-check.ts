// Checks a config's `[rule_options]` tables against the rules they name
// (pub#510). An unknown rule id or option name is silently ignored at audit
// time, and a value of the wrong type fails that rule's options parse, so
// `squirrel config validate` and the audit's preflight report all three,
// naming the table the user wrote.

import type { Rule } from "./types";

import { loadKnownRules } from "./loader";

/** Keys the rule filter reads from every table, outside any rule's optionsSchema. */
const FILTER_OPTION_KEYS = new Set(["enabled"]);

export interface RuleOptionsProblem {
  /**
   * `unknown-rule`, `unknown-option` and `ignored-value` change nothing when the
   * audit runs; `invalid-value` stops it once the rule runs.
   */
  kind: "unknown-rule" | "unknown-option" | "ignored-value" | "invalid-value";
  ruleId: string;
  /** The option the problem is about, or null for the table as a whole. */
  key: string | null;
  /** One line naming the table and the key, ready to print. */
  message: string;
}

/** The table header as written in squirrel.toml: `[rule_options."core/meta-title"]`. */
export function ruleOptionsTable(ruleId: string): string {
  return `[rule_options.${JSON.stringify(ruleId)}]`;
}

/** The parts of a zod issue the messages use. */
interface OptionIssue {
  path: readonly PropertyKey[];
  message: string;
}

/**
 * One line per issue, naming the table and the option:
 * `[rule_options."core/meta-title"] min_length: Invalid input: expected number, received string`.
 */
export function describeRuleOptionIssues(
  ruleId: string,
  issues: readonly OptionIssue[],
): string[] {
  return issues.map((issue) => {
    const where = issue.path.map(String).join(".");
    return `${ruleOptionsTable(ruleId)}${where ? ` ${where}` : ""}: ${issue.message}`;
  });
}

/** Up to three known ids with the same name in another category (`performance/ttfb` → `perf/ttfb`). */
function similarRuleIds(ruleId: string, rules: Map<string, Rule>): string[] {
  const name = (ruleId.split("/").pop() ?? ruleId).toLowerCase();
  const matches: string[] = [];
  for (const id of rules.keys()) {
    const lower = id.toLowerCase();
    if (lower === ruleId.toLowerCase() || lower.split("/").pop() === name) {
      matches.push(id);
    }
  }
  return matches.slice(0, 3);
}

/**
 * Every problem in `ruleOptions`, in table order. `rules` defaults to every
 * built-in rule, disabled ones included: a disabled rule's options can still be
 * read elsewhere (the CLI sends the `gaps/*` options to the cloud).
 */
export function checkRuleOptions(
  ruleOptions: Record<string, Record<string, unknown>>,
  rules: Map<string, Rule> = loadKnownRules(),
): RuleOptionsProblem[] {
  const problems: RuleOptionsProblem[] = [];

  for (const [ruleId, table] of Object.entries(ruleOptions)) {
    const rule = rules.get(ruleId);
    if (!rule) {
      const similar = similarRuleIds(ruleId, rules);
      const hint =
        similar.length > 0 ? ` (did you mean ${similar.map((id) => `"${id}"`).join(" or ")}?)` : "";
      problems.push({
        kind: "unknown-rule",
        ruleId,
        key: null,
        message: `${ruleOptionsTable(ruleId)}: no rule has this id, so the table changes nothing${hint}`,
      });
      continue;
    }

    // The rule filter reads only a boolean `enabled`; anything else is ignored.
    if ("enabled" in table && typeof table.enabled !== "boolean") {
      problems.push({
        kind: "ignored-value",
        ruleId,
        key: "enabled",
        message: `${ruleOptionsTable(ruleId)} enabled: must be true or false, so it changes nothing`,
      });
    }

    const schema = rule.meta.optionsSchema;
    const declared = Object.keys(schema?.shape ?? {});
    const options =
      declared.length > 0 ? `options: ${declared.join(", ")}` : "this rule takes no options";
    for (const key of Object.keys(table)) {
      if (FILTER_OPTION_KEYS.has(key) || declared.includes(key)) continue;
      problems.push({
        kind: "unknown-option",
        ruleId,
        key,
        message: `${ruleOptionsTable(ruleId)} ${key}: not an option of ${ruleId}, so it changes nothing (${options})`,
      });
    }

    if (!schema) continue;
    const parsed = schema.safeParse(table);
    if (parsed.success) continue;
    const lines = describeRuleOptionIssues(ruleId, parsed.error.issues);
    parsed.error.issues.forEach((issue, i) => {
      problems.push({
        kind: "invalid-value",
        ruleId,
        key: issue.path.length > 0 ? String(issue.path[0]) : null,
        message: lines[i]!,
      });
    });
  }

  return problems;
}
