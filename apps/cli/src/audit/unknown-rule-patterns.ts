// `[rules] enable` / `disable` entries that match no rule (#1587). A typo such as
// `eeat/nope` used to be accepted silently, so the rule kept running and nobody
// knew why. The audit warns once on stderr and carries on.

import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import { editDistance } from "@/cli/help";
import { isValidCategory, normalizeCategoryCode } from "@/rules/categories";

export interface UnknownRulePattern {
  /** The entry as written in squirrel.toml. */
  pattern: string;
  /** The closest known id or `category/*` glob, when one is near enough. */
  suggestion?: string;
}

/** True when the entry selects at least one known rule or names a real category glob. */
function isKnownPattern(pattern: string, ruleIds: readonly string[]): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    // `category/*` with a real category is valid even if the category is empty.
    if (isValidCategory(normalizeCategoryCode(pattern.slice(0, -2)))) {
      return true;
    }
  }
  return ruleIds.some((id) => matchesRulePattern(id, pattern));
}

function closest(
  pattern: string,
  candidates: readonly string[]
): string | undefined {
  const lower = pattern.toLowerCase();
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = editDistance(lower, candidate.toLowerCase());
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  // Far enough away that a suggestion would mislead: say nothing.
  const limit = Math.max(2, Math.floor(pattern.length / 3));
  return bestScore <= limit ? best : undefined;
}

/**
 * Every entry of `patterns` that matches no rule in `ruleIds`, each with the
 * closest rule id (or category glob) as a suggestion. Entries repeated in the
 * list are reported once.
 */
export function findUnknownRulePatterns(
  patterns: readonly string[],
  ruleIds: readonly string[],
  categories: readonly string[]
): UnknownRulePattern[] {
  const candidates = [...ruleIds, ...categories.map((c) => `${c}/*`)];
  const out: UnknownRulePattern[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    if (isKnownPattern(pattern, ruleIds)) continue;
    const suggestion = closest(pattern, candidates);
    out.push(suggestion ? { pattern, suggestion } : { pattern });
  }
  return out;
}

/** The one-line stderr warning, or undefined when every entry is known. */
export function formatUnknownRuleWarning(
  disable: readonly UnknownRulePattern[],
  enable: readonly UnknownRulePattern[]
): string | undefined {
  const describe = (list: string, items: readonly UnknownRulePattern[]) =>
    items.map(
      (u) =>
        `"${u.pattern}" in [rules] ${list}${u.suggestion ? ` (did you mean "${u.suggestion}"?)` : ""}`
    );
  const parts = [
    ...describe("disable", disable),
    ...describe("enable", enable),
  ];
  if (parts.length === 0) return undefined;
  return `Warning: no rule matches ${parts.join("; ")}. Ids look like category/rule and globs like eeat/* work; ids are listed at https://docs.squirrelscan.com/rules.`;
}
