// Checks a config's `[rule_options]` tables against the rules they name
// (pub#510). An unknown rule id or option name is silently ignored at audit
// time, and a value of the wrong type fails that rule's options parse, so
// `squirrel config validate` and the audit's preflight report all three,
// naming the table the user wrote.

import type { Rule } from "./types";

import { IgnoreTable, isIgnorable, ruleMatcher, type IgnoreEntry } from "./ignore";
import { loadKnownRules } from "./loader";

/** Option names the per-rule form of the ignore used to propose (#1262); the `[[ignore]]` table replaces them. */
const RESERVED_IGNORE_KEYS = new Set(["ignore", "ignore_items", "ignore_urls", "ignore_selectors"]);

/** Keys the rule filter reads from every table, outside any rule's optionsSchema. */
const FILTER_OPTION_KEYS = new Set(["enabled"]);

export interface RuleOptionsProblem {
  /**
   * `unknown-rule`, `unknown-option` and `ignored-value` change nothing when the
   * audit runs; `invalid-value` stops it once the rule runs.
   */
  kind:
    | "unknown-rule"
    | "unknown-option"
    | "ignored-value"
    | "invalid-value"
    /** An `[[ignore]]` entry that cannot do what it says (#1262); the audit carries on without it. */
    | "ignore-entry";
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
      if (RESERVED_IGNORE_KEYS.has(key)) {
        problems.push({
          kind: "unknown-option",
          ruleId,
          key,
          message: `${ruleOptionsTable(ruleId)} ${key}: waivers are not a rule option, so it changes nothing; use [[ignore]] with rule = "${ruleId}" (items, urls)`,
        });
        continue;
      }
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

/**
 * Every problem with a config's `[[ignore]]` entries (#1262), in entry order: a
 * rule pattern that names no rule, an entry that names a rule that cannot be waived
 * (compromise detection), and a matcher that was refused (an unsafe or invalid
 * regex). The schema has already refused an entry with neither items nor urls and
 * a `selectors` key. Every one changes nothing at audit time (the entry or the
 * matcher is skipped), so `squirrel config validate` reports them as it does the
 * `[rule_options]` ones.
 */
export function checkIgnoreEntries(
  entries: readonly IgnoreEntry[] | undefined,
  rules: Map<string, Rule> = loadKnownRules(),
): RuleOptionsProblem[] {
  const problems: RuleOptionsProblem[] = [];
  if (!entries || entries.length === 0) return problems;
  const where = (i: number, rule: string) => `[[ignore]] entry ${i + 1} (${rule})`;

  entries.forEach((entry, i) => {
    const matches = ruleMatcher(entry.rule);
    const matching = [...rules.values()].filter((r) => matches(r.meta.id));
    if (matching.length === 0) {
      const similar = entry.rule.includes("*") ? [] : similarRuleIds(entry.rule, rules);
      const hint = similar.length > 0 ? ` (did you mean ${similar.map((id) => `"${id}"`).join(" or ")}?)` : "";
      problems.push({
        kind: "ignore-entry",
        ruleId: entry.rule,
        key: "rule",
        message: `${where(i, entry.rule)}: no rule matches, so the entry changes nothing${hint}`,
      });
      return;
    }
    const locked = matching.filter((r) => !isIgnorable(r.meta));
    if (locked.length > 0 && locked.length === matching.length) {
      problems.push({
        kind: "ignore-entry",
        ruleId: entry.rule,
        key: "rule",
        message: `${where(i, entry.rule)}: compromise detection cannot be ignored (${locked.map((r) => r.meta.id).slice(0, 3).join(", ")}), so the entry changes nothing`,
      });
    }
  });

  for (const problem of new IgnoreTable(entries).problems) {
    const entry = entries[problem.entry]!;
    problems.push({
      kind: "ignore-entry",
      ruleId: entry.rule,
      key: problem.field,
      message: `${where(problem.entry, entry.rule)} ${problem.field}: "${problem.pattern.slice(0, 60)}" is ${problem.message}, so it is not applied`,
    });
  }
  return capProblems(problems);
}

/** `config validate` prints one line per problem: a hostile config could make thousands, so print the first ones and count the rest. */
const MAX_IGNORE_PROBLEMS = 20;
function capProblems(problems: RuleOptionsProblem[]): RuleOptionsProblem[] {
  if (problems.length <= MAX_IGNORE_PROBLEMS) return problems;
  const rest = problems.length - MAX_IGNORE_PROBLEMS;
  return [
    ...problems.slice(0, MAX_IGNORE_PROBLEMS),
    { kind: "ignore-entry", ruleId: "", key: "rule", message: `[[ignore]]: and ${rest} more problem${rest === 1 ? "" : "s"} like these` },
  ];
}
