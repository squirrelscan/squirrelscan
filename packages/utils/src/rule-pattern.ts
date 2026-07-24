// Deps-free, worker-clean rule-id pattern matcher; single source of truth so
// the matching semantics can never silently diverge.

// Legacy category-code aliases (old code → canonical). MIRROR of CATEGORY_ALIASES
// in packages/core-contracts/src/index.ts (canonical), packages/rules/src/categories.ts,
// and packages/report/src/categories.ts — update all four together when adding an
// alias (guarded by apps/cli/tests/rules/category-alias-consistency.test.ts). Kept
// inline so this module stays dependency-free (worker-clean). Needed so a
// `category/*` enable/disable written with one code (e.g. `ax/*`) still matches
// rules whose id kept the other code (e.g. `ai/site-metadata`) after a category
// was renamed but only some rule ids were re-prefixed (#357 ai→ax, #504; adblock→blocking).
const CATEGORY_ALIASES: Record<string, string> = {
  adblock: "blocking",
  ai: "ax",
};

/** Map a (possibly legacy) category code to its current canonical code. */
function canonicalCategory(code: string): string {
  // Object.hasOwn (not `?? code`) so a category literally named "__proto__" can't
  // resolve to Object.prototype and violate the string return type.
  return Object.hasOwn(CATEGORY_ALIASES, code) ? CATEGORY_ALIASES[code] : code;
}

/** Split a rule id / pattern into `{ category, rest }` at the first `/`. */
function splitCategory(value: string): { category: string; rest: string } {
  const slash = value.indexOf("/");
  if (slash === -1) return { category: "", rest: value };
  return { category: value.slice(0, slash), rest: value.slice(slash + 1) };
}

/**
 * Test a rule id against an enable/disable pattern.
 *
 * Supported forms:
 * - `"*"` matches every rule
 * - `"category/*"` matches all rules in a category (e.g. `core/*` → `core/meta-title`)
 * - `"category/rule"` exact match
 *
 * Category matching is **alias-aware**: a pattern's category and the rule id's
 * category are both normalized through CATEGORY_ALIASES before comparison, so
 * `ax/*` matches `ai/site-metadata` (and vice versa) even though only some ids
 * were re-prefixed when the category was folded (#357/#504). Bare patterns with
 * no `/` keep exact-string semantics.
 */
export function matchesRulePattern(ruleId: string, pattern: string): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith("/*")) {
    const patternCategory = pattern.slice(0, -2);
    const { category: idCategory } = splitCategory(ruleId);
    // A bare id with no child (no `/`) is not a category member.
    if (idCategory === "") return false;
    return canonicalCategory(idCategory) === canonicalCategory(patternCategory);
  }

  // Exact "category/rule" — alias-aware on the category half.
  const p = splitCategory(pattern);
  if (p.category === "") return ruleId === pattern; // bare pattern → exact id
  const id = splitCategory(ruleId);
  return (
    canonicalCategory(id.category) === canonicalCategory(p.category) &&
    id.rest === p.rest
  );
}
