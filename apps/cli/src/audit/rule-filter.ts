// --rule-include / --rule-exclude (#1066): run-time rule filtering for
// `squirrel audit`. Wiring only — actual enable/disable resolution stays in
// packages/rules/src/filter.ts (isRuleEnabled); this module is the CLI-side
// upgrade that lets a bare token mean "this whole category" instead of
// falling back to matchesRulePattern's bare-token = exact-rule-id semantics
// (which would silently match zero rules for a typo'd category name).

import {
  isValidCategory,
  normalizeCategoryCode,
  RULE_CATEGORY_VALUES,
} from "@/rules/categories";

export interface RuleFilterParseResult {
  /** Resolved enable patterns from --rule-include; empty when not passed. */
  enable: string[];
  /** Resolved disable patterns from --rule-exclude; empty when not passed. */
  disable: string[];
  errors: string[];
}

/** Split repeated and/or comma-joined flag values into trimmed tokens.
 * Mirrors normalizeFailOnArgs / normalizeHeaderArgs. */
export function normalizeRuleFilterArgs(
  value: string | string[] | undefined
): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function expandToken(
  token: string,
  flag: "--rule-include" | "--rule-exclude"
): { pattern: string } | { error: string } {
  const slash = token.indexOf("/");
  if (slash === -1) {
    // Bare token — must name a known category (the CLI-only upgrade this
    // module exists for; see file header).
    const canonical = normalizeCategoryCode(token);
    if (isValidCategory(canonical)) return { pattern: `${canonical}/*` };
    return {
      error: `${flag} "${token}": unknown category. Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}`,
    };
  }
  // "category/*" or "category/rule" — validate the category half too, so
  // `--rule-include bogus/thing` errors instead of silently matching zero
  // rules (the same failure mode a bad bare token would hit).
  const category = token.slice(0, slash);
  const canonical = normalizeCategoryCode(category);
  if (!isValidCategory(canonical)) {
    return {
      error: `${flag} "${token}": unknown category "${category}". Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}`,
    };
  }
  return { pattern: token };
}

/** Parse --rule-include/--rule-exclude flag values into enable/disable
 * patterns, expanding bare category tokens and validating them up front so a
 * typo errors before crawling rather than silently matching nothing. */
export function parseRuleFilters(
  includeArgs: string | string[] | undefined,
  excludeArgs: string | string[] | undefined
): RuleFilterParseResult {
  const errors: string[] = [];
  const enable: string[] = [];
  const disable: string[] = [];

  for (const token of normalizeRuleFilterArgs(includeArgs)) {
    const r = expandToken(token, "--rule-include");
    if ("error" in r) errors.push(r.error);
    else enable.push(r.pattern);
  }
  for (const token of normalizeRuleFilterArgs(excludeArgs)) {
    const r = expandToken(token, "--rule-exclude");
    if ("error" in r) errors.push(r.error);
    else disable.push(r.pattern);
  }

  return { enable, disable, errors };
}

/** Merge CLI --rule-include/--rule-exclude patterns into the config's
 * enable/disable lists: include REPLACES enable (only the named categories
 * run), exclude APPENDS to disable. Shared by the pre-crawl --fail-on
 * validation and mergeOptionsToConfig so both use identical resolution. */
export function resolveRulesConfig(
  base: { enable: string[]; disable: string[] },
  filter: { enable: string[]; disable: string[] }
): { enable: string[]; disable: string[] } {
  return {
    enable: filter.enable.length > 0 ? filter.enable : base.enable,
    disable: [...base.disable, ...filter.disable],
  };
}

/** True when every category the --rule-include patterns touch is also
 * excluded — a self-contradictory filter (e.g. `--rule-include ax
 * --rule-exclude ax`) that would crawl the whole site and score zero
 * categories. Callers reject it before crawling. Patterns arrive already
 * expanded/normalized by parseRuleFilters, so the category half is canonical. */
export function filterResolvesToZeroCategories(
  enable: string[],
  resolved: { enable: string[]; disable: string[] }
): boolean {
  if (enable.length === 0) return false;
  // An enable pattern is wiped by `*`, a whole-category disable, or an
  // identical exact-rule disable. An exact disable of a DIFFERENT rule leaves
  // the category's other rules running (unlike isCategoryExcluded's
  // conservative --fail-on semantics), so it doesn't count here. An enable
  // like `core/*` with every core rule disabled one-by-one slips through —
  // rule inventory isn't visible at this layer.
  const wiped = (ep: string) => {
    const cat = normalizeCategoryCode(ep.split("/")[0]);
    return resolved.disable.some(
      (dp) =>
        dp === "*" ||
        (dp.endsWith("/*") && normalizeCategoryCode(dp.slice(0, -2)) === cat) ||
        dp === ep
    );
  };
  return enable.every(wiped);
}

/** True when `pattern` could enable/disable at least one rule in `category` —
 * `*`, `category/*`, and exact `category/rule` (any rule) all count, alias-
 * aware on the category half. Deliberately category-level, NOT delegated to
 * matchesRulePattern with a fake probe id: an exact `category/rule` pattern
 * would never match a synthetic rule id (matchesRulePattern requires the
 * exact rest to match), which previously made `isCategoryExcluded` treat
 * `--rule-include core/meta-title` as excluding all of `core`. */
function patternTouchesCategory(pattern: string, category: string): boolean {
  if (pattern === "*") return true;
  const slash = pattern.indexOf("/");
  if (slash === -1) return false; // shouldn't occur post-parseRuleFilters
  return (
    normalizeCategoryCode(pattern.slice(0, slash)) ===
    normalizeCategoryCode(category)
  );
}

/** True when the resolved enable/disable patterns leave `category` with zero
 * rules that could run — disable wins over enable (mirrors isRuleEnabled's
 * precedence), and an enable list that never mentions the category means
 * nothing in it was turned on. Used to reject `--fail-on score:<category>`
 * against an excluded category before crawling starts.
 * Known limitation: per-rule `rule_options.<id>.enabled = true` overrides
 * (which outrank disable patterns in isRuleEnabled) aren't visible here, so
 * such a rule's category still reads as excluded. */
export function isCategoryExcluded(
  category: string,
  resolved: { enable: string[]; disable: string[] }
): boolean {
  const touches = (p: string) => patternTouchesCategory(p, category);
  if (resolved.disable.some(touches)) return true;
  if (resolved.enable.length === 0) return true;
  return !resolved.enable.some(touches);
}
