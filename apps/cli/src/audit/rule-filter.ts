// --rule-include / --rule-exclude (#1066). The parse/validate core lives in
// @squirrelscan/rules (packages/rules/src/rule-filter.ts) so the cloud API's
// `enabledRulePatterns` runs the SAME matcher; it is re-exported here so every
// CLI import path and test is unchanged. What stays here needs the loaded rule
// set (`isCategoryExcluded`), which the worker-clean core must not import.

import { loadAllRules } from "@squirrelscan/rules";
import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import { normalizeCategoryCode } from "@/rules/categories";

export {
  filterResolvesToZeroCategories,
  normalizeRuleFilterArgs,
  parseRuleFilters,
  resolvePendingRuleFilters,
  resolveRulesConfig,
  type PendingRuleFilterToken,
  type RuleFilterParseOptions,
  type RuleFilterParseResult,
} from "@squirrelscan/rules";

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

let filedOutsidePrefix: Map<string, string[]> | null = null;

/** Ids of the rules in `category` whose id prefix names another category. */
function idsFiledOutsidePrefix(category: string): string[] {
  if (!filedOutsidePrefix) {
    filedOutsidePrefix = new Map();
    for (const rule of loadAllRules().values()) {
      const code = normalizeCategoryCode(rule.meta.category);
      const prefix = normalizeCategoryCode(rule.meta.id.split("/")[0] ?? "");
      if (code === prefix) continue;
      const ids = filedOutsidePrefix.get(code) ?? [];
      ids.push(rule.meta.id);
      filedOutsidePrefix.set(code, ids);
    }
  }
  return filedOutsidePrefix.get(normalizeCategoryCode(category)) ?? [];
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
  resolved: { enable: string[]; disable: string[] },
  /** Rules of the plugins loaded for this run (#1599): their ids and categories count like built-ins'. */
  pluginRules: readonly { id: string; category: string }[] = []
): boolean {
  // pub#836: a rule can be filed under a category its id prefix does not
  // name (`links/broken-links` is a Reliability rule), so a pattern reaches
  // the category through that rule's id too.
  // A plugin rule always sits in a namespace of its own, so it is filed outside
  // the category's prefix whatever category it reports under (#1599).
  const wanted = normalizeCategoryCode(category);
  const foreign = [
    ...idsFiledOutsidePrefix(category),
    ...pluginRules
      .filter((r) => normalizeCategoryCode(r.category) === wanted)
      .map((r) => r.id),
  ];
  const touches = (p: string) =>
    patternTouchesCategory(p, category) ||
    foreign.some((id) => matchesRulePattern(id, p));
  if (resolved.disable.some(touches)) return true;
  if (resolved.enable.length === 0) return true;
  return !resolved.enable.some(touches);
}
