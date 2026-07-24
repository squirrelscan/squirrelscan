// CATEGORY_ALIASES / normalizeCategoryCode / deriveBlockingSubcategory are
// intentionally mirrored across four dep-light packages (core-contracts is
// canonical; rules + report re-define to stay dependency-free; utils inlines a
// fourth copy in the alias-aware rule-pattern matcher, #504). This test fails
// loudly if the copies ever diverge — the drift guard the dedup follow-up replaces.
import {
  normalizeCategoryCode as ncCore,
  deriveBlockingSubcategory as dbCore,
} from "@squirrelscan/core-contracts";
import {
  normalizeCategoryCode as ncReport,
  deriveBlockingSubcategory as dbReport,
  getCategoryGroup as groupReport,
  GROUP_CODES as GROUP_CODES_REPORT,
  GROUPS as GROUPS_REPORT,
  CATEGORIES as CATEGORIES_REPORT,
} from "@squirrelscan/report";
import {
  normalizeCategoryCode as ncRules,
  getCategoryGroup as groupRules,
  getCategoriesInGroup,
  GROUP_CODES as GROUP_CODES_RULES,
  GROUPS as GROUPS_RULES,
  CATEGORY_CODES,
} from "@squirrelscan/rules";
import { matchesRulePattern } from "@squirrelscan/utils";
import { describe, expect, test } from "bun:test";

// Known codes + the legacy alias + an unknown passthrough.
const CODES = [
  "adblock",
  "blocking",
  "ai",
  "ax",
  "core",
  "links",
  "perf",
  "unknown-code",
  "",
];

const RULE_IDS = [
  "adblock/element-hiding",
  "adblock/blocked-links",
  "adblock/privacy-blocked",
  "adblock/future-rule",
  "core/title",
];

describe("category alias mirrors stay in sync", () => {
  test("normalizeCategoryCode is identical across core-contracts, rules, report", () => {
    for (const code of CODES) {
      const core = ncCore(code);
      expect(ncRules(code)).toBe(core);
      expect(ncReport(code)).toBe(core);
    }
  });

  test("the legacy adblock alias resolves to blocking everywhere", () => {
    expect(ncCore("adblock")).toBe("blocking");
    expect(ncRules("adblock")).toBe("blocking");
    expect(ncReport("adblock")).toBe("blocking");
  });

  test("the legacy ai alias resolves to ax everywhere", () => {
    expect(ncCore("ai")).toBe("ax");
    expect(ncRules("ai")).toBe("ax");
    expect(ncReport("ai")).toBe("ax");
  });

  test("deriveBlockingSubcategory is identical across core-contracts and report", () => {
    for (const ruleId of RULE_IDS) {
      expect(dbReport(ruleId)).toBe(dbCore(ruleId));
    }
  });

  // Group mapping (#626) is mirrored in packages/rules/src/categories.ts
  // (canonical) and packages/report/src/categories.ts (dep-free renderer copy).
  // These guard that the two mirrors agree and that every category has a group.
  const VALID_GROUPS = ["seo", "performance", "security", "ai"];

  test("GROUP_CODES agree across rules and report (same order)", () => {
    expect([...GROUP_CODES_RULES] as string[]).toEqual([...GROUP_CODES_REPORT]);
    expect([...GROUP_CODES_RULES] as string[]).toEqual(VALID_GROUPS);
  });

  test("group display names/titles agree across rules and report", () => {
    for (const code of GROUP_CODES_RULES) {
      expect(GROUPS_REPORT[code].name).toBe(GROUPS_RULES[code].name);
      expect(GROUPS_REPORT[code].title).toBe(GROUPS_RULES[code].title);
    }
    // The user-facing rename (#626): short name "Agents", full title spelled out.
    expect(GROUPS_RULES.ai.name).toBe("Agents");
    expect(GROUPS_RULES.ai.title).toBe("Agent Experience");
  });

  test("every category maps to the same valid group in both mirrors", () => {
    for (const code of CATEGORY_CODES) {
      const g = groupRules(code);
      expect(VALID_GROUPS).toContain(g);
      expect(groupReport(code)).toBe(g);
    }
  });

  test("the report mirror has an entry for every canonical category, each with a group", () => {
    for (const code of CATEGORY_CODES) {
      const info = CATEGORIES_REPORT[code];
      expect(info).toBeDefined();
      expect(VALID_GROUPS).toContain(info.group);
    }
  });

  test("getCategoriesInGroup partitions all categories exactly once", () => {
    const seen = GROUP_CODES_RULES.flatMap((g) => getCategoriesInGroup(g));
    expect([...seen].sort()).toEqual([...CATEGORY_CODES].sort());
    expect(seen.length).toBe(CATEGORY_CODES.length); // no category in two groups
  });

  // Guards the fourth mirror (utils/rule-pattern.ts). For every legacy alias in
  // the canonical table, a `${canonical}/*` enable must match a rule whose id
  // kept the old prefix (and vice versa) — the exact #504 failure mode. A new
  // alias added to core-contracts but not to rule-pattern.ts fails here.
  test("matchesRulePattern honors every canonical alias (rule-pattern.ts mirror in sync)", () => {
    for (const code of CODES) {
      const canonical = ncCore(code);
      if (code === "" || canonical === code) continue; // only the legacy aliases
      expect(matchesRulePattern(`${code}/some-rule`, `${canonical}/*`)).toBe(
        true
      );
      expect(matchesRulePattern(`${canonical}/some-rule`, `${code}/*`)).toBe(
        true
      );
      expect(
        matchesRulePattern(`${code}/some-rule`, `${canonical}/some-rule`)
      ).toBe(true);
    }
  });
});
