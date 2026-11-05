// --rule-include / --rule-exclude (#1066): run-time rule filtering for
// `squirrel audit`. Wiring only — actual enable/disable resolution stays in
// packages/rules/src/filter.ts (isRuleEnabled); this module is the CLI-side
// upgrade that lets a bare token mean "this whole category" instead of
// falling back to matchesRulePattern's bare-token = exact-rule-id semantics
// (which would silently match zero rules for a typo'd category name).

import { loadAllRules } from "@squirrelscan/rules";
import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import {
  isValidCategory,
  normalizeCategoryCode,
  RULE_CATEGORY_VALUES,
} from "@/rules/categories";

/** A token that names no built-in category: valid only if a loaded plugin owns the namespace (#1599). */
export interface PendingRuleFilterToken {
  flag: "--rule-include" | "--rule-exclude";
  token: string;
  namespace: string;
}

export interface RuleFilterParseOptions {
  /** Namespaces of the plugins loaded for this run: a token naming one is a plugin rule selection. */
  pluginNamespaces?: ReadonlySet<string>;
  /**
   * Plugins load after the flags are parsed. With this on, a token whose category is
   * unknown is kept (and listed in `pending`) instead of failing; the caller settles
   * it with {@link resolvePendingRuleFilters} once the plugins are known.
   */
  deferUnknown?: boolean;
}

export interface RuleFilterParseResult {
  /** Tokens waiting on the plugin namespaces; present only with `deferUnknown` and an unknown category. */
  pending?: PendingRuleFilterToken[];
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
  flag: "--rule-include" | "--rule-exclude",
  options: RuleFilterParseOptions = {}
): { pattern: string; pending?: PendingRuleFilterToken } | { error: string } {
  const slash = token.indexOf("/");
  const namespace = slash === -1 ? token : token.slice(0, slash);
  if (!isValidCategory(normalizeCategoryCode(namespace))) {
    // A plugin namespace is a selection of its own (#1599).
    if (options.pluginNamespaces?.has(namespace)) {
      return { pattern: slash === -1 ? `${token}/*` : token };
    }
    if (options.deferUnknown) {
      return {
        pattern: slash === -1 ? `${token}/*` : token,
        pending: { flag, token, namespace },
      };
    }
  }
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
  excludeArgs: string | string[] | undefined,
  options: RuleFilterParseOptions = {}
): RuleFilterParseResult {
  const errors: string[] = [];
  const enable: string[] = [];
  const disable: string[] = [];
  const pending: PendingRuleFilterToken[] = [];

  for (const token of normalizeRuleFilterArgs(includeArgs)) {
    const r = expandToken(token, "--rule-include", options);
    if ("error" in r) errors.push(r.error);
    else {
      enable.push(r.pattern);
      if (r.pending) pending.push(r.pending);
    }
  }
  for (const token of normalizeRuleFilterArgs(excludeArgs)) {
    const r = expandToken(token, "--rule-exclude", options);
    if ("error" in r) errors.push(r.error);
    else {
      disable.push(r.pattern);
      if (r.pending) pending.push(r.pending);
    }
  }

  return {
    enable,
    disable,
    errors,
    ...(pending.length > 0 ? { pending } : {}),
  };
}

/**
 * Settle the tokens {@link parseRuleFilters} deferred, now that the plugin
 * namespaces are known. One that no loaded plugin owns is the same error an
 * unknown category always was, so a typo still fails before the crawl.
 */
export function resolvePendingRuleFilters(
  pending: readonly PendingRuleFilterToken[],
  pluginNamespaces: ReadonlySet<string>
): string[] {
  return pending
    .filter((p) => !pluginNamespaces.has(p.namespace))
    .map(
      (p) =>
        `${p.flag} "${p.token}": unknown category "${p.namespace}". Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}${pluginNamespaces.size > 0 ? `; plugin namespaces: ${[...pluginNamespaces].join(", ")}` : ""}`
    );
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
  resolved: { enable: string[]; disable: string[] }
): boolean {
  // pub#836: a rule can be filed under a category its id prefix does not
  // name (`links/broken-links` is a Reliability rule), so a pattern reaches
  // the category through that rule's id too.
  const foreign = idsFiledOutsidePrefix(category);
  const touches = (p: string) =>
    patternTouchesCategory(p, category) ||
    foreign.some((id) => matchesRulePattern(id, p));
  if (resolved.disable.some(touches)) return true;
  if (resolved.enable.length === 0) return true;
  return !resolved.enable.some(touches);
}
