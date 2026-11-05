import { describe, expect, test } from "bun:test";

import {
  filterResolvesToZeroCategories,
  isCategoryExcluded,
  normalizeRuleFilterArgs,
  parseRuleFilters,
  resolvePendingRuleFilters,
  resolveRulesConfig,
} from "../../src/audit/rule-filter";

describe("normalizeRuleFilterArgs", () => {
  test("undefined → empty list", () => {
    expect(normalizeRuleFilterArgs(undefined)).toEqual([]);
  });

  test("comma-separated string splits into tokens", () => {
    expect(normalizeRuleFilterArgs("ax,perf")).toEqual(["ax", "perf"]);
  });

  test("repeated flags accumulate (citty array) and combine with commas", () => {
    expect(normalizeRuleFilterArgs(["ax,perf", "images"])).toEqual([
      "ax",
      "perf",
      "images",
    ]);
  });

  test("trims whitespace and drops blanks", () => {
    expect(normalizeRuleFilterArgs(" ax , , perf ")).toEqual(["ax", "perf"]);
  });
});

describe("parseRuleFilters", () => {
  test("bare category token expands to category/*", () => {
    const r = parseRuleFilters("ax,perf", undefined);
    expect(r.errors).toEqual([]);
    expect(r.enable).toEqual(["ax/*", "perf/*"]);
    expect(r.disable).toEqual([]);
  });

  test("exact category/rule and category/* pass through unchanged", () => {
    const r = parseRuleFilters(undefined, "images/*,core/meta-title");
    expect(r.errors).toEqual([]);
    expect(r.disable).toEqual(["images/*", "core/meta-title"]);
  });

  test("legacy alias bare token normalizes to canonical category", () => {
    // ai -> ax (#357/#504)
    const r = parseRuleFilters("ai", undefined);
    expect(r.errors).toEqual([]);
    expect(r.enable).toEqual(["ax/*"]);
  });

  test("unknown bare token errors, listing valid categories", () => {
    const r = parseRuleFilters("bogus-category", undefined);
    expect(r.enable).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("--rule-include");
    expect(r.errors[0]).toContain("bogus-category");
    expect(r.errors[0]).toContain("Valid categories:");
  });

  test("collects errors from both include and exclude independently", () => {
    const r = parseRuleFilters("bogus1", "bogus2");
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("--rule-include");
    expect(r.errors[1]).toContain("--rule-exclude");
  });

  test("unknown category half of a slashed token errors instead of silently matching nothing", () => {
    const r = parseRuleFilters("bogus/thing", undefined);
    expect(r.enable).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("bogus");
    expect(r.errors[0]).toContain("Valid categories:");
  });

  test("known category half of a slashed exact-rule token passes through", () => {
    const r = parseRuleFilters("core/meta-title", undefined);
    expect(r.errors).toEqual([]);
    expect(r.enable).toEqual(["core/meta-title"]);
  });

  test("no flags passed → empty everything, no errors", () => {
    const r = parseRuleFilters(undefined, undefined);
    expect(r).toEqual({ enable: [], disable: [], errors: [] });
  });
});

describe("resolveRulesConfig", () => {
  test("no filter → base config unchanged", () => {
    const base = { enable: ["*"], disable: [] };
    expect(resolveRulesConfig(base, { enable: [], disable: [] })).toEqual(base);
  });

  test("--rule-include REPLACES enable (default ['*'] is dropped)", () => {
    const base = { enable: ["*"], disable: [] };
    const r = resolveRulesConfig(base, {
      enable: ["ax/*", "perf/*"],
      disable: [],
    });
    expect(r.enable).toEqual(["ax/*", "perf/*"]);
  });

  test("--rule-exclude APPENDS to disable, keeping existing config disables", () => {
    const base = { enable: ["*"], disable: ["legacy/rule"] };
    const r = resolveRulesConfig(base, {
      enable: [],
      disable: ["images/*"],
    });
    expect(r.disable).toEqual(["legacy/rule", "images/*"]);
  });
});

describe("isCategoryExcluded", () => {
  test("a category holding rules filed outside their id prefix is reached through those ids (pub#836)", () => {
    // links/broken-links is a Reliability rule: including it reaches the
    // Reliability score, and excluding all of reliability/* does not stop it.
    expect(
      isCategoryExcluded("reliability", {
        enable: ["links/broken-links"],
        disable: [],
      })
    ).toBe(false);
    expect(
      isCategoryExcluded("reliability", { enable: ["links/*"], disable: [] })
    ).toBe(false);
    expect(
      isCategoryExcluded("reliability", { enable: ["core/*"], disable: [] })
    ).toBe(true);
  });

  test("category covered by disable/* pattern → excluded", () => {
    expect(
      isCategoryExcluded("images", { enable: ["*"], disable: ["images/*"] })
    ).toBe(true);
  });

  test("category not mentioned by a non-default enable list → excluded", () => {
    expect(
      isCategoryExcluded("seo", { enable: ["ax/*", "perf/*"], disable: [] })
    ).toBe(true);
  });

  test("category present in the enable list and not disabled → included", () => {
    expect(
      isCategoryExcluded("ax", { enable: ["ax/*", "perf/*"], disable: [] })
    ).toBe(false);
  });

  test("disable wins over enable for the same category (isRuleEnabled precedence)", () => {
    expect(
      isCategoryExcluded("ax", { enable: ["ax/*"], disable: ["ax/*"] })
    ).toBe(true);
  });

  test("default enable ['*'] with no exclude → every category included", () => {
    expect(isCategoryExcluded("core", { enable: ["*"], disable: [] })).toBe(
      false
    );
  });

  test("empty enable list (degenerate) → everything excluded", () => {
    expect(isCategoryExcluded("core", { enable: [], disable: [] })).toBe(true);
  });

  // Regression: an exact "category/rule" enable pattern must count as
  // touching the category, even though the rule name never matches a
  // synthetic probe id.
  test("category included via an exact category/rule pattern (not just category/*)", () => {
    expect(
      isCategoryExcluded("core", {
        enable: ["core/meta-title"],
        disable: [],
      })
    ).toBe(false);
  });

  test("category excluded via an exact category/rule disable pattern", () => {
    expect(
      isCategoryExcluded("images", {
        enable: ["*"],
        disable: ["images/lazy-loading"],
      })
    ).toBe(true);
  });

  test("legacy alias category name matches a canonical-category pattern", () => {
    // ai -> ax (#357/#504)
    expect(isCategoryExcluded("ai", { enable: ["ax/*"], disable: [] })).toBe(
      false
    );
  });
});

describe("filterResolvesToZeroCategories", () => {
  test("no include patterns → never contradictory", () => {
    expect(
      filterResolvesToZeroCategories([], { enable: ["*"], disable: ["ax/*"] })
    ).toBe(false);
  });

  test("include ax + exclude ax → contradiction", () => {
    expect(
      filterResolvesToZeroCategories(["ax/*"], {
        enable: ["ax/*"],
        disable: ["ax/*"],
      })
    ).toBe(true);
  });

  test("include ax,perf + exclude ax → perf survives", () => {
    expect(
      filterResolvesToZeroCategories(["ax/*", "performance/*"], {
        enable: ["ax/*", "performance/*"],
        disable: ["ax/*"],
      })
    ).toBe(false);
  });

  test("exact-rule exclude does NOT wipe its category's include", () => {
    expect(
      filterResolvesToZeroCategories(["images/*"], {
        enable: ["images/*"],
        disable: ["images/lazy-loading"],
      })
    ).toBe(false);
  });

  test("identical exact-rule include and exclude → contradiction", () => {
    expect(
      filterResolvesToZeroCategories(["core/meta-title"], {
        enable: ["core/meta-title"],
        disable: ["core/meta-title"],
      })
    ).toBe(true);
  });

  test("disable * wipes everything", () => {
    expect(
      filterResolvesToZeroCategories(["ax/*"], {
        enable: ["ax/*"],
        disable: ["*"],
      })
    ).toBe(true);
  });

  test("alias-aware: include ai wiped by exclude ax", () => {
    expect(
      filterResolvesToZeroCategories(["ai/*"], {
        enable: ["ai/*"],
        disable: ["ax/*"],
      })
    ).toBe(true);
  });
});

describe("plugin namespaces in --rule-include / --rule-exclude (#1599)", () => {
  test("a loaded plugin namespace is a selection of its own, bare or with a rule name", () => {
    const r = parseRuleFilters(undefined, ["acme", "acme/page-note"], {
      pluginNamespaces: new Set(["acme"]),
    });
    expect(r.errors).toEqual([]);
    expect(r.disable).toEqual(["acme/*", "acme/page-note"]);
  });

  test("without the plugin, the same token is still an unknown category", () => {
    const r = parseRuleFilters(undefined, ["acme"]);
    expect(r.errors[0]).toContain("unknown category");
  });

  test("deferUnknown keeps the token pending until the plugins are known, then a typo still fails", () => {
    const r = parseRuleFilters(undefined, ["acme", "acmee/x", "core"], {
      deferUnknown: true,
    });
    expect(r.errors).toEqual([]);
    expect(r.disable).toEqual(["acme/*", "acmee/x", "core/*"]);
    expect(r.pending?.map((p) => p.namespace)).toEqual(["acme", "acmee"]);
    const errors = resolvePendingRuleFilters(
      r.pending ?? [],
      new Set(["acme"])
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"acmee/x"');
    expect(errors[0]).toContain("plugin namespaces: acme");
  });

  test("with no plugin loaded, a deferred typo reads byte for byte as it does without plugin support", () => {
    for (const token of ["bogus", "bogus/thing"]) {
      const plain = parseRuleFilters(undefined, [token]);
      const deferred = parseRuleFilters(undefined, [token], {
        deferUnknown: true,
      });
      const settled = resolvePendingRuleFilters(
        deferred.pending ?? [],
        new Set()
      );
      expect(settled).toEqual(plain.errors);
    }
    expect(
      resolvePendingRuleFilters(
        parseRuleFilters(["bogus"], undefined, { deferUnknown: true })
          .pending ?? [],
        new Set()
      )[0]
    ).toStartWith(
      '--rule-include "bogus": unknown category. Valid categories:'
    );
  });

  test("where plugins are loaded the error also lists their namespaces", () => {
    const [error] = resolvePendingRuleFilters(
      parseRuleFilters(undefined, ["acmee"], { deferUnknown: true }).pending ??
        [],
      new Set(["acme"])
    );
    expect(error).toContain("unknown category. Valid categories:");
    expect(error).toContain("plugin namespaces: acme");
  });
});
