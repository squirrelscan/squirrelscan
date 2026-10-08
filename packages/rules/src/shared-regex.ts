// Module-level `/g` and `/y` regexes carry `lastIndex` between calls. A rule that
// the time budget (rule-budget.ts) abandons mid `exec()` loop leaves that index
// somewhere in the string, and the next rule that reuses the same regex without
// resetting it would start mid-string and silently miss matches. Regexes used
// with `exec`/`test` at module level are registered here; the abandon path
// resets every one of them, so a rule need not defend against a predecessor it
// cannot know was killed.
//
// A new module-level `/g` or `/y` regex that is driven with `exec` or `test`
// must be wrapped in `sharedRegex(...)`; tests/shared-regex.test.ts scans the
// sources and fails when one is not.

const registry = new Set<RegExp>();

/** Register a shared stateful (`/g` or `/y`) regex for reset on abandon; returns it unchanged. */
export function sharedRegex<T extends RegExp>(re: T): T {
  if (re.global || re.sticky) registry.add(re);
  return re;
}

/** Reset `lastIndex` to 0 on every registered regex. */
export function resetSharedRegexes(): void {
  for (const re of registry) re.lastIndex = 0;
}
