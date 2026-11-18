import { parseRuleFilters, expandGroupPatterns } from "@squirrelscan/rules";
import { describe, expect, test } from "bun:test";

import type { AuditReport } from "@/types";

import { expandConfigRuleGroups, getDefaultConfig } from "@/config";
import { filterByGroup, parseGroupArg } from "@/reports/filters";
import { getCategoriesInGroup } from "@/rules/categories";

function reportWith(categories: string[]): AuditReport {
  const ruleResults: Record<string, unknown> = {};
  for (const c of categories) {
    ruleResults[`${c}/x`] = { meta: { id: `${c}/x`, category: c } };
  }
  return { ruleResults } as unknown as AuditReport;
}

describe("group:<id> expansion (#626)", () => {
  test("expands to member category/* patterns, others pass through", () => {
    const r = expandGroupPatterns(["group:security", "core/meta-title"]);
    expect(r.errors).toEqual([]);
    expect(r.patterns).toEqual([
      ...getCategoriesInGroup("security").map((c) => `${c}/*`),
      "core/meta-title",
    ]);
  });

  test("unknown group errors and lists valid groups", () => {
    const r = expandGroupPatterns(["group:bogus"]);
    expect(r.errors[0]).toContain(
      "Valid groups: seo, performance, security, ai"
    );
  });

  test("rules.disable group:performance disables the perf category", () => {
    const cfg = getDefaultConfig();
    cfg.rules.disable = ["group:performance"];
    const out = expandConfigRuleGroups(cfg);
    expect(out.rules.disable).toContain("perf/*");
    expect(out.rules.disable).not.toContain("group:performance");
    expect(out.rules.enable).toEqual(cfg.rules.enable);
  });

  test("rules.enable group:ai enables exactly the member categories", () => {
    const cfg = getDefaultConfig();
    cfg.rules.enable = ["group:ai"];
    expect(expandConfigRuleGroups(cfg).rules.enable).toEqual(
      getCategoriesInGroup("ai").map((c) => `${c}/*`)
    );
  });

  test("config load throws on unknown group", () => {
    const cfg = getDefaultConfig();
    cfg.rules.disable = ["group:nope"];
    expect(() => expandConfigRuleGroups(cfg)).toThrow("unknown group");
  });

  test("--rule-include group:security expands; unknown errors", () => {
    expect(parseRuleFilters("group:security", undefined).enable).toEqual(
      getCategoriesInGroup("security").map((c) => `${c}/*`)
    );
    expect(parseRuleFilters("group:nope", undefined).errors).toHaveLength(1);
  });
});

describe("report --group filter (#626)", () => {
  test("keeps only categories in the group", () => {
    const sec = getCategoriesInGroup("security");
    const perf = getCategoriesInGroup("performance");
    const out = filterByGroup(reportWith([...sec, ...perf, "core"]), [
      "security",
    ]);
    const cats = Object.values(out.ruleResults).map((r) => r.meta.category);
    expect(cats.sort()).toEqual([...sec].sort());
  });

  test("parseGroupArg reports invalid ids", () => {
    expect(parseGroupArg("security, seo")).toEqual({
      groups: ["security", "seo"],
      invalid: [],
    });
    expect(parseGroupArg("bogus").invalid).toEqual(["bogus"]);
  });

  test("inherited Object.prototype names are not valid groups", () => {
    expect(parseGroupArg("constructor")).toEqual({
      groups: [],
      invalid: ["constructor"],
    });
    expect(parseGroupArg("__proto__").invalid).toEqual(["__proto__"]);
    const r = expandGroupPatterns(["group:toString"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(
      "Valid groups: seo, performance, security, ai"
    );
  });
});
