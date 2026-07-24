// Unit tests for the shared rule-id pattern matcher.

import { describe, expect, test } from "bun:test";

import { matchesRulePattern } from "../src/rule-pattern";

describe("matchesRulePattern", () => {
  test('"*" matches every rule id', () => {
    expect(matchesRulePattern("core/meta-title", "*")).toBe(true);
    expect(matchesRulePattern("perf/lcp", "*")).toBe(true);
    expect(matchesRulePattern("", "*")).toBe(true);
  });

  test('"category/*" matches all rules in that category', () => {
    expect(matchesRulePattern("core/meta-title", "core/*")).toBe(true);
    expect(matchesRulePattern("core/canonical", "core/*")).toBe(true);
  });

  test('"category/*" does not match other categories', () => {
    expect(matchesRulePattern("perf/lcp", "core/*")).toBe(false);
    // Prefix must be followed by "/" — "corex/foo" is not in "core".
    expect(matchesRulePattern("corex/foo", "core/*")).toBe(false);
    // The bare category id without a child is not matched by "category/*".
    expect(matchesRulePattern("core", "core/*")).toBe(false);
  });

  test('"category/rule" matches only that exact rule', () => {
    expect(matchesRulePattern("core/meta-title", "core/meta-title")).toBe(true);
    expect(matchesRulePattern("core/meta-titles", "core/meta-title")).toBe(false);
    expect(matchesRulePattern("core/canonical", "core/meta-title")).toBe(false);
  });

  test("non-matching pattern returns false", () => {
    expect(matchesRulePattern("core/meta-title", "perf/lcp")).toBe(false);
    expect(matchesRulePattern("core/meta-title", "")).toBe(false);
  });

  test("edge cases resolve via exact equality (documents prior semantics)", () => {
    // A bare category id exact-matches a bare pattern (not the same as "core/*").
    expect(matchesRulePattern("core", "core")).toBe(true);
    // Empty id and empty pattern are exact-equal.
    expect(matchesRulePattern("", "")).toBe(true);
  });
});

describe("matchesRulePattern — category-code aliases (#504)", () => {
  // The `ax` category has mixed id prefixes after the ai→ax fold (#357): some
  // rules are `ax/…`, four kept `ai/…`. A `ax/*` enable must match BOTH or the
  // Stage-0 `ai/site-metadata` rule is silently dropped (empty Site Profile).
  test("`ax/*` matches both ax/- and ai/-prefixed rules in the category", () => {
    expect(matchesRulePattern("ax/ai-crawlers", "ax/*")).toBe(true);
    expect(matchesRulePattern("ai/site-metadata", "ax/*")).toBe(true); // the #504 repro
    expect(matchesRulePattern("ai/page-type-match", "ax/*")).toBe(true);
    expect(matchesRulePattern("ai/llm-parsability", "ax/*")).toBe(true);
    expect(matchesRulePattern("ai/ai-content", "ax/*")).toBe(true);
  });

  test("`ai/*` (legacy code) also matches the whole canonical category", () => {
    expect(matchesRulePattern("ai/site-metadata", "ai/*")).toBe(true);
    expect(matchesRulePattern("ax/ai-crawlers", "ai/*")).toBe(true);
  });

  test("exact `category/rule` is alias-aware on the category half", () => {
    expect(matchesRulePattern("ai/site-metadata", "ax/site-metadata")).toBe(true);
    expect(matchesRulePattern("ai/site-metadata", "ai/site-metadata")).toBe(true);
    // …but the rule name still has to match exactly.
    expect(matchesRulePattern("ai/site-metadata", "ax/page-type-match")).toBe(false);
  });

  test("adblock→blocking alias works the same way", () => {
    expect(matchesRulePattern("adblock/cookie-banner", "blocking/*")).toBe(true);
    expect(matchesRulePattern("adblock/cookie-banner", "blocking/cookie-banner")).toBe(true);
  });

  test("aliases do not bleed across unrelated categories", () => {
    expect(matchesRulePattern("core/meta-title", "ax/*")).toBe(false);
    expect(matchesRulePattern("ai/site-metadata", "core/*")).toBe(false);
    expect(matchesRulePattern("perf/lcp", "ax/*")).toBe(false);
  });
});
