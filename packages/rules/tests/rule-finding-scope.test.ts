// EVERY rule declares a findingScope (repo#1885). Optional in the type, enforced here as a
// named per-rule failure, like `rule-verdict-scope.test.ts`.

import { describe, expect, test } from "bun:test";

import { loadAllRules } from "../src/loader";
import { mayCollapseAcrossPages, type RuleMeta } from "../src/types";

const rules = [...loadAllRules().values()];

// Measured per-page on a real crawl (repo#1885): their locator is the page or a per-page fact.
const PAGE_RULES = [
  "ax/token-weight",
  "core/meta-description",
  "perf/cls-hints",
  "images/dimensions",
  "images/offscreen-lazy",
];

describe("findingScope declarations", () => {
  test("the catalog loaded", () => {
    expect(rules.length).toBeGreaterThan(100);
  });

  test.each(rules.map((r) => [r.meta.id, r.meta] as const))("%s declares a findingScope", (_id, meta) => {
    expect(["page", "resource"]).toContain(meta.findingScope!);
  });

  test.each(PAGE_RULES)("%s is page scope", (id) => {
    const rule = rules.find((r) => r.meta.id === id);
    expect(rule?.meta.findingScope).toBe("page");
  });
});

describe("mayCollapseAcrossPages", () => {
  test("page and undeclared never collapse; only an explicit resource does", () => {
    expect(mayCollapseAcrossPages({ findingScope: "page" } as RuleMeta)).toBe(false);
    expect(mayCollapseAcrossPages({} as RuleMeta)).toBe(false);
    expect(mayCollapseAcrossPages({ findingScope: "resource" } as RuleMeta)).toBe(true);
  });
});
