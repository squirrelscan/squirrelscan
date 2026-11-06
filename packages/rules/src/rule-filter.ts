// --rule-include / --rule-exclude (#1066): run-time rule filtering for
// `squirrel audit`, and the cloud API's `enabledRulePatterns` (private#3785):
// ONE implementation so the two surfaces cannot drift. Moved here from
// apps/cli/src/audit/rule-filter.ts (which re-exports it). Deliberately free of
// the rule loader (and so of linkedom): the cloud API is a Cloudflare Worker and
// imports this through the `@squirrelscan/rules/rule-filter` subpath, with rule
// ids from its generated catalog. `isCategoryExcluded`, which needs the loaded
// rules, stays in the CLI. Wiring only — actual enable/disable resolution stays in
// packages/rules/src/filter.ts (isRuleEnabled); this module is the CLI-side
// upgrade that lets a bare token mean "this whole category" instead of
// falling back to matchesRulePattern's bare-token = exact-rule-id semantics
// (which would silently match zero rules for a typo'd category name).

import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

import {
  isValidCategory,
  normalizeCategoryCode,
  RULE_CATEGORY_VALUES,
} from "./categories";

/** A token that names no built-in category: valid only if a loaded plugin owns the namespace (#1599). */
export interface PendingRuleFilterToken {
  flag: "--rule-include" | "--rule-exclude";
  token: string;
  namespace: string;
  /** No `/` in the token: the error then reads as it always did for a bare typo. */
  bare: boolean;
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
        pending: { flag, token, namespace, bare: slash === -1 },
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
  const suffix =
    pluginNamespaces.size > 0
      ? `; plugin namespaces: ${[...pluginNamespaces].join(", ")}`
      : "";
  return pending
    .filter((p) => !pluginNamespaces.has(p.namespace))
    .map(
      (p) =>
        // Same text as expandToken's errors, so a run without plugins is unchanged.
        `${p.flag} "${p.token}": unknown category${p.bare ? "" : ` "${p.namespace}"`}. Valid categories: ${RULE_CATEGORY_VALUES.join(", ")}${suffix}`
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

/** The patterns that match NO rule id in `ruleIds`. The category check in
 * parseRuleFilters is category-only (`core/robots-metaa` passes it and silently
 * selects nothing), so a surface that must refuse a dead pattern (the cloud
 * API: an empty run is an error there, not a result) runs this over the
 * expanded patterns. Same matcher as the run itself (matchesRulePattern), so
 * "matches nothing here" means "selects nothing at run time". */
export function findUnmatchedRulePatterns(
  patterns: readonly string[],
  ruleIds: Iterable<string>
): string[] {
  const ids = [...ruleIds];
  return patterns.filter((p) => !ids.some((id) => matchesRulePattern(id, p)));
}
