// Tests for rule loader

import { describe, expect, test } from "bun:test";

import type { Rule } from "../../src/rules/types";

import { RULE_MODULES } from "../../src/rules";
import { loadAllRules } from "../../src/rules/loader";

describe("loadAllRules", () => {
  test("loads all rules", () => {
    const rules = loadAllRules();
    expect(rules.size).toBeGreaterThan(0);
  });

  test("rules have correct id format", () => {
    const rules = loadAllRules();
    for (const [id, rule] of rules) {
      expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(rule.meta.id).toBe(id);
    }
  });

  test("rules have required meta fields", () => {
    const rules = loadAllRules();
    for (const [_id, rule] of rules) {
      expect(rule.meta.name).toBeTruthy();
      expect(rule.meta.description).toBeTruthy();
      expect(rule.meta.category).toBeTruthy();
      expect(rule.meta.scope).toMatch(/^(page|site)$/);
      expect(rule.meta.severity).toMatch(/^(error|warning|info)$/);
      expect(typeof rule.meta.weight).toBe("number");
    }
  });

  test("rules have run function", () => {
    const rules = loadAllRules();
    for (const [_id, rule] of rules) {
      expect(typeof rule.run).toBe("function");
    }
  });

  test("includes core rules", () => {
    const rules = loadAllRules();
    expect(rules.has("core/meta-title")).toBe(true);
    expect(rules.has("core/meta-description")).toBe(true);
    expect(rules.has("core/canonical")).toBe(true);
    expect(rules.has("core/h1")).toBe(true);
  });

  test("includes content rules", () => {
    const rules = loadAllRules();
    expect(rules.has("content/heading-hierarchy")).toBe(true);
    expect(rules.has("content/word-count")).toBe(true);
  });

  test("includes i18n rules", () => {
    const rules = loadAllRules();
    expect(rules.has("i18n/lang-attribute")).toBe(true);
    expect(rules.has("i18n/hreflang")).toBe(true);
  });

  test("includes rules for every category (except disabled/other)", () => {
    const rules = loadAllRules();
    const categories = new Set(
      Array.from(rules.values(), (rule) => rule.meta.category)
    );
    // "other" is a fallback category - no rules should use it directly
    // "ax", "blocking", and "gaps" are mostly cloud-backed categories
    const expectedCategories = [
      "core",
      "content",
      "links",
      "images",
      "schema",
      "security",
      "integrity",
      "a11y",
      "i18n",
      "perf",
      "social",
      "crawl",
      "url",
      "mobile",
      "legal",
      "local",
      "video",
      "analytics",
      "eeat",
    ] as const;

    for (const category of expectedCategories) {
      expect(categories.has(category)).toBe(true);
    }

    // Verify loaded rules only use known categories (including "other", "ax", "blocking", "gaps")
    for (const category of categories) {
      expect([
        ...expectedCategories,
        "other",
        "ax",
        "blocking",
        "gaps",
      ]).toContain(category);
    }
  });

  test("all blocking-category rules declare a subcategory", () => {
    // Sub-group rendering (ad / privacy) and the deriveBlockingSubcategory
    // legacy backfill both rely on every blocking rule setting meta.subcategory.
    // Guard the invariant so a future adblock/* rule can't silently omit it.
    const rules = loadAllRules();
    const blocking = Array.from(rules.values()).filter(
      (rule) => rule.meta.category === "blocking"
    );
    expect(blocking.length).toBeGreaterThan(0);
    for (const rule of blocking) {
      expect(rule.meta.subcategory).toBeTruthy();
    }
  });

  test("rule modules list uses perf", () => {
    expect(RULE_MODULES).toContain("perf");
    expect(RULE_MODULES).toContain("social");
    expect(RULE_MODULES).toContain("crawl");
    expect(RULE_MODULES).toContain("url");
    expect(RULE_MODULES).toContain("mobile");
    expect(RULE_MODULES).toContain("legal");
    expect(RULE_MODULES).toContain("local");
    expect(RULE_MODULES).toContain("video");
    expect(RULE_MODULES).toContain("analytics");
    expect(RULE_MODULES).toContain("eeat");
    expect(RULE_MODULES).not.toContain("performance");
  });

  test("includes additional namespaces when provided", () => {
    const customRule: Rule = {
      meta: {
        id: "custom/custom-rule",
        name: "Custom Rule",
        description: "Provided by plugin namespace",
        category: "content",
        scope: "page",
        severity: "warning",
        weight: 1,
      },
      run: () => ({ checks: [] }),
    };

    const rules = loadAllRules({
      additionalNamespaces: [{ name: "custom", rules: [customRule] }],
    });
    expect(rules.has("custom/custom-rule")).toBe(true);
  });
});
