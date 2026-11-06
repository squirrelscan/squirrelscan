// The matcher moved to @squirrelscan/rules (packages/rules/src/rule-filter.ts)
// so the cloud API's `enabledRulePatterns` runs the SAME code as
// --rule-include / --rule-exclude. Re-exported here so every CLI import path
// and test is unchanged.
export {
  filterResolvesToZeroCategories,
  isCategoryExcluded,
  normalizeRuleFilterArgs,
  parseRuleFilters,
  resolvePendingRuleFilters,
  resolveRulesConfig,
  type PendingRuleFilterToken,
  type RuleFilterParseOptions,
  type RuleFilterParseResult,
} from "@squirrelscan/rules";
