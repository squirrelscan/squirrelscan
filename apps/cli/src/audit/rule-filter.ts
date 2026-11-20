// --rule-include / --rule-exclude (#1066). The parse/validate core lives in
// @squirrelscan/rules (packages/rules/src/rule-filter.ts) so the cloud API's
// `enabledRulePatterns` runs the SAME matcher; it is re-exported here so every
// CLI import path and test is unchanged. What stays here needs the loaded rule
// set (`isCategoryExcluded`), which the worker-clean core must not import.

import type { WcagLevel } from "@squirrelscan/core-contracts/wcag";

import {
  filterResolvesToZeroCategories,
  isRuleEnabled,
  loadAllRules,
  wcagLevelDisablePatterns,
} from "@squirrelscan/rules";
import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import type { PartialAudit } from "@/types";

import {
  normalizeCategoryCode,
  RULE_CATEGORY_VALUES,
} from "@/rules/categories";

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

/**
 * `--wcag-level` / `[rules] wcag_level` (repo#3093): the exact ids of the a11y rules the level leaves out,
 * as disable patterns. Empty when no level is set.
 */
export function wcagRuleDisables(level: WcagLevel | undefined): string[] {
  if (!level) return [];
  return wcagLevelDisablePatterns(
    loadAllRules()
      .values()
      .map((r) => r.meta),
    level
  );
}

/**
 * The pre-crawl refusal for a filter that leaves no rule to run, or null. `--rule-include X --rule-exclude X`
 * is a contradiction; `--rule-include a11y/touch-targets --wcag-level AA` (repo#3093) selects only rules the
 * level leaves out. `resolved` carries the `--rule-exclude` and config disables, `wcagDisables` the level's.
 */
export function zeroRulesError(
  enable: string[],
  resolved: { enable: string[]; disable: string[] },
  wcag: { level: WcagLevel | undefined; disables: string[] }
): string | null {
  if (filterResolvesToZeroCategories(enable, resolved)) {
    return "--rule-include/--rule-exclude (or [rules] enable/disable) contradict each other: every included category is also excluded, so no rules would run";
  }
  if (
    wcag.level &&
    wcag.disables.length > 0 &&
    filterResolvesToZeroCategories(enable, {
      enable: resolved.enable,
      disable: [...resolved.disable, ...wcag.disables],
    })
  ) {
    return `The rule selection (--rule-include or [rules] enable) selects only accessibility rules that WCAG level ${wcag.level} (--wcag-level or [rules] wcag_level) leaves out, so no rules would run`;
  }
  return null;
}

/**
 * Whether a run is partial: narrowed by `--rule-include`/`--rule-exclude` (repo#1082) or by a WCAG level
 * (`--wcag-level` or `[rules] wcag_level`, repo#3093). `buildPartialAudit` returns a marker exactly when this
 * is true, and `squirrel audit`'s publish guard reads it, so a run that carries the marker is the run auto-publish
 * skips as `rule-filter`, and `squirrel report --publish` (which reads the marker) gets the same answer.
 */
export function isPartialRun(
  filter: { enable: readonly string[]; disable: readonly string[] },
  wcagLevel?: WcagLevel
): boolean {
  return (
    filter.enable.length > 0 ||
    filter.disable.length > 0 ||
    wcagLevel !== undefined
  );
}

/**
 * The partial-audit marker for a run narrowed with `--rule-include`/`--rule-exclude` (repo#1082) or a WCAG
 * level (repo#3093), or undefined for an unfiltered run. `includedCategories` is every category with at least
 * one rule that still runs under the filter, decided per rule with the engine's own `isRuleEnabled`, so
 * excluding one rule (`--rule-exclude core/meta-title`) keeps its category while `--rule-exclude core/*` drops
 * it. `exclude` stays the user's patterns; the level is recorded as `wcagLevel`.
 */
export function buildPartialAudit(
  filter: { enable: string[]; disable: string[] },
  pluginRules: readonly {
    id: string;
    category: string;
    optIn?: boolean;
  }[] = [],
  wcagLevel?: WcagLevel
): PartialAudit | undefined {
  if (!isPartialRun(filter, wcagLevel)) return undefined;
  // No include list means every rule is enabled (the engine's default `*`).
  const enable = filter.enable.length > 0 ? filter.enable : ["*"];
  const disable = [...filter.disable, ...wcagRuleDisables(wcagLevel)];
  const scored = new Set<string>();
  const consider = (id: string, category: string, optIn?: boolean) => {
    if (isRuleEnabled(id, enable, disable, undefined, optIn === true)) {
      scored.add(normalizeCategoryCode(category));
    }
  };
  for (const rule of loadAllRules().values()) {
    consider(rule.meta.id, rule.meta.category, rule.meta.optIn);
  }
  for (const rule of pluginRules) consider(rule.id, rule.category, rule.optIn);
  const includedCategories = RULE_CATEGORY_VALUES.map((c) =>
    normalizeCategoryCode(c)
  ).filter((c) => scored.has(c));
  return {
    include: [...filter.enable],
    exclude: [...filter.disable],
    includedCategories,
    ...(wcagLevel ? { wcagLevel } : {}),
  };
}
