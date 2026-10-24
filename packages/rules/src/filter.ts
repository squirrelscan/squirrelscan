// Rule enable/disable resolution; the pattern matcher lives in @squirrelscan/utils.
import { matchesRulePattern } from "@squirrelscan/utils/rule-pattern";

// Re-exported as matchesPattern to preserve the public rules API surface.
export { matchesRulePattern as matchesPattern };

// Determine if a rule is enabled based on enable/disable patterns
// Order of precedence:
// 1. Per-rule enabled: false in config takes highest precedence
// 2. Opt-in rules require a concrete enable pattern (the default "*" is ignored)
// 3. Disable patterns are checked
// 4. Enable patterns are checked
export function isRuleEnabled(
  ruleId: string,
  enable: string[],
  disable: string[],
  ruleConfig?: { enabled?: boolean },
  optIn = false
): boolean {
  // Per-rule config takes highest precedence
  if (ruleConfig?.enabled === false) return false;
  if (ruleConfig?.enabled === true) return true;

  // `*` is the default selection and must not spend credits on opt-in rules.
  // A concrete id/category pattern is an intentional opt-in.
  if (
    optIn &&
    !enable.some(
      (pattern) => pattern !== "*" && matchesRulePattern(ruleId, pattern)
    )
  ) {
    return false;
  }

  // Check disable patterns (any match disables)
  for (const pattern of disable) {
    if (matchesRulePattern(ruleId, pattern)) return false;
  }

  // Check enable patterns (any match enables)
  for (const pattern of enable) {
    if (matchesRulePattern(ruleId, pattern)) return true;
  }

  // Default: disabled if no patterns match
  return false;
}

// Filter a list of rule IDs based on config
export function filterRules(
  ruleIds: string[],
  enable: string[] | undefined,
  disable: string[] | undefined,
  ruleOptions: Record<string, { enabled?: boolean }>,
  ruleRegistry?: ReadonlyMap<string, { meta: { optIn?: boolean } }>
): string[] {
  return ruleIds.filter((id) =>
    isRuleEnabled(
      id,
      enable ?? [],
      disable ?? [],
      ruleOptions[id],
      ruleRegistry?.get(id)?.meta.optIn === true
    )
  );
}
